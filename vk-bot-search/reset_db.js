// ПОЛНОЕ ПЕРЕСОЗДАНИЕ базы: удаляет ВСЕ таблицы вместе с данными (пользователи,
// обращения, переписка, база знаний) и создаёт схему заново, загружая FAQ из
// faq_data.json. Нужен только для чистой установки.
//
// Для обновления существующей базы — migrate_update.js: он данные не трогает.
//
//   node reset_db.js          — спросит подтверждение
//   node reset_db.js --yes    — без вопроса (для автоматической установки)
//
// Раньше скрипт назывался migrate_all.js и удалял всё без единого вопроса —
// по названию его легко было принять за безобидную «миграцию».
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const db = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

/**
 * Показывает, КАКАЯ база будет удалена и что в ней лежит, и просит ввести её имя.
 * Имя, а не «да»: так приходится посмотреть, на какую базу смотрит скрипт, —
 * и не снести продовую, думая, что это локальная. Имя латиницей, поэтому
 * ввод не зависит от кодировки терминала.
 */
async function confirmReset() {
    const target = `${process.env.DB_NAME} на ${process.env.DB_HOST}:${process.env.DB_PORT || 5432}`;

    const counts = [];
    for (const [table, label] of [['users', 'пользователей'], ['tickets', 'обращений'], ['messages', 'сообщений'], ['faq', 'вопросов FAQ']]) {
        try {
            const r = await db.query(`SELECT count(*) FROM ${table}`);
            counts.push(`${label}: ${r.rows[0].count}`);
        } catch (_) { /* таблицы ещё нет */ }
    }

    console.log('\n⚠️  ПОЛНОЕ ПЕРЕСОЗДАНИЕ БАЗЫ — все данные будут удалены безвозвратно.');
    console.log(`   База: ${target}`);
    console.log(`   Сейчас в ней: ${counts.length ? counts.join(', ') : 'таблиц проекта нет'}`);
    console.log('   Для обновления существующей базы без потери данных есть migrate_update.js\n');

    if (process.argv.includes('--yes')) {
        console.log('   Подтверждено флагом --yes.');
        return true;
    }
    if (!process.stdin.isTTY) {
        console.error('Нет подтверждения: запустите скрипт в терминале или добавьте флаг --yes.');
        return false;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(`Чтобы удалить всё, введите имя базы (${process.env.DB_NAME}): `, resolve));
    rl.close();
    return answer.trim() === process.env.DB_NAME;
}

async function runMigration() {
    try {
        await db.connect();

        if (!(await confirmReset())) {
            console.log('Отменено — база не изменена.');
            process.exitCode = 1;
            return;
        }
        console.log('Подключение к БД...');

        // Включаем расширение для нечеткого поиска (триграммы)
        await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

        // Сохраняем настройки ИИ перед сносом таблиц
        let savedSettings = null;
        try {
            const r = await db.query('SELECT * FROM app_settings WHERE id = TRUE');
            if (r.rows.length > 0) savedSettings = r.rows[0];
        } catch (_) { /* таблица ещё не существует — ок */ }

        console.log('Очистка таблиц...');
        await db.query(`
            DROP TABLE IF EXISTS feedback CASCADE;
            DROP TABLE IF EXISTS messages CASCADE;
            DROP TABLE IF EXISTS tickets CASCADE;
            DROP TABLE IF EXISTS faq CASCADE;
            DROP TABLE IF EXISTS users CASCADE;
            DROP TABLE IF EXISTS operator_codes CASCADE;
            DROP TABLE IF EXISTS vk_groups CASCADE;
            DROP TABLE IF EXISTS ai_queue CASCADE;
            DROP TABLE IF EXISTS ai_usage CASCADE;
            DROP TABLE IF EXISTS app_settings CASCADE;
            DROP TABLE IF EXISTS session CASCADE;
        `);

        console.log('Создание новой структуры...');

        await db.query(`
            CREATE TABLE vk_groups (
                id SERIAL PRIMARY KEY,
                group_id BIGINT UNIQUE NOT NULL,
                group_name TEXT NOT NULL,
                access_token TEXT NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW(),
                -- курс из названия сообщества («Второй курс …» → 2) и признак архива
                course INTEGER,
                is_archived BOOLEAN NOT NULL DEFAULT FALSE,
                name_synced_at TIMESTAMP
            );

            CREATE TABLE operator_codes (
                code TEXT PRIMARY KEY,
                admin_name TEXT NOT NULL
            );

            CREATE TABLE users (
                vk_id BIGINT PRIMARY KEY,
                role TEXT DEFAULT 'student',
                full_name TEXT,
                group_number TEXT,
                linked_code TEXT,
                state TEXT DEFAULT 'registration_start',
                current_chat_ticket_id INTEGER,
                study_years INTEGER DEFAULT 4,
                vk_group_id BIGINT,
                is_graduated BOOLEAN DEFAULT FALSE,
                ai_context JSONB DEFAULT '[]',
                -- фото, присланные до вопроса: прикладываются к обращению администратору
                pending_attachments JSONB,
                -- последний вопрос студента: в payload кнопки он не помещается (лимит VK — 255 символов)
                pending_question TEXT,
                -- уведомления администратора о новых вопросах (переключаются в боте)
                notify_tickets BOOLEAN NOT NULL DEFAULT TRUE,
                -- черновик записи базы знаний, пока администратор его не подтвердил
                faq_draft JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE ai_queue (
                id SERIAL PRIMARY KEY,
                vk_id BIGINT NOT NULL REFERENCES users(vk_id) ON DELETE CASCADE,
                vk_group_id BIGINT NOT NULL,
                ai_context JSONB NOT NULL,
                faq_context TEXT,
                status TEXT DEFAULT 'pending',
                attempts INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                -- момент взятия задачи в работу; по нему ищутся зависшие задачи
                started_at TIMESTAMP
            );
            CREATE INDEX idx_ai_queue_status ON ai_queue(status);
            CREATE INDEX idx_users_vk_group ON users(vk_group_id);

            -- Расход токенов GigaChat: у каждого класса моделей своя независимая квота
            CREATE TABLE ai_usage (
                model_class TEXT PRIMARY KEY,
                model_id    TEXT NOT NULL,
                tokens_used BIGINT NOT NULL DEFAULT 0,
                quota       BIGINT NOT NULL,
                exhausted   BOOLEAN NOT NULL DEFAULT FALSE,
                updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE faq (
                id SERIAL PRIMARY KEY,
                category TEXT,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                keywords TEXT,
                -- когда вопрос завели: по ней сортируется список в админке
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                
                -- ИНДЕКС: Ищем ТОЛЬКО в вопросе + ключевых словах (ответ исключен)
                -- COALESCE нужен, чтобы если keywords пустые, поиск не ломался
                search_vector TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('russian', question || ' ' || COALESCE(keywords, ''))
                ) STORED
            );
            
            -- Индекс для полнотекстового поиска
            CREATE INDEX faq_search_idx ON faq USING GIN (search_vector);
            
            -- НОВЫЙ ИНДЕКС: Для нечеткого поиска (trigrams)
            CREATE INDEX faq_trgm_idx ON faq USING GIN (
                (question || ' ' || COALESCE(keywords, '')) gin_trgm_ops
            );

            CREATE TABLE tickets (
                id SERIAL PRIMARY KEY,
                student_vk_id BIGINT NOT NULL,
                -- сообщество, в котором задан вопрос. Вся переписка по обращению
                -- идёт через токен этого сообщества, поэтому и очередь, и диалоги
                -- администратора ограничены им: из чужого сообщества ответ просто
                -- не дошёл бы до студента
                vk_group_id BIGINT,
                operator_vk_id BIGINT,
                question TEXT NOT NULL,
                status TEXT DEFAULT 'open',
                -- фото, присланные вместе с вопросом: их видит любой администратор,
                -- взявший обращение, а не только получивший уведомление
                attachments TEXT[],
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX idx_tickets_group_status ON tickets(vk_group_id, status);
            CREATE INDEX tickets_status_idx ON tickets (status);

            CREATE TABLE messages (
                id SERIAL PRIMARY KEY,
                ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
                sender_vk_id BIGINT,
                text TEXT,
                attachments TEXT[],
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX idx_messages_ticket ON messages(ticket_id);

            -- Singleton-таблица настроек ИИ (ровно 1 строка, id = TRUE всегда)
            CREATE TABLE app_settings (
                id BOOLEAN PRIMARY KEY DEFAULT TRUE,
                ollama_url TEXT DEFAULT 'http://127.0.0.1:11434',
                ollama_model TEXT DEFAULT 'qwen2.5:7b',
                gigachat_key TEXT,
                gigachat_scope TEXT DEFAULT 'GIGACHAT_API_PERS',
                gigachat_model TEXT DEFAULT 'GigaChat-2'
            );
            INSERT INTO app_settings (id) VALUES (TRUE) ON CONFLICT DO NOTHING;

            -- Сессии входа в админку (connect-pg-simple): переживают перезапуск бота
            CREATE TABLE session (
                sid    VARCHAR PRIMARY KEY,
                sess   JSON NOT NULL,
                expire TIMESTAMP(6) NOT NULL
            );
            CREATE INDEX idx_session_expire ON session (expire);

            CREATE TABLE feedback (
                id SERIAL PRIMARY KEY,
                vk_id BIGINT NOT NULL,
                text TEXT NOT NULL,
                status TEXT DEFAULT 'new',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Восстанавливаем сохранённые настройки ИИ (если были) или берём из .env как fallback
        const restoredKey = (savedSettings && savedSettings.gigachat_key) || process.env.GIGACHAT_AUTH_KEY || null;
        const restoredScope = (savedSettings && savedSettings.gigachat_scope) || process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
        const restoredOllamaUrl = (savedSettings && savedSettings.ollama_url) || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
        const restoredOllamaModel = (savedSettings && savedSettings.ollama_model) || process.env.OLLAMA_MODEL || 'qwen2.5:7b';
        const restoredGigaModel = (savedSettings && savedSettings.gigachat_model) || 'GigaChat-2';

        await db.query(
            `UPDATE app_settings SET
                gigachat_key = $1, gigachat_scope = $2,
                ollama_url = $3, ollama_model = $4, gigachat_model = $5
             WHERE id = TRUE`,
            [restoredKey, restoredScope, restoredOllamaUrl, restoredOllamaModel, restoredGigaModel]
        );
        console.log('✅ Настройки ИИ восстановлены' + (savedSettings ? ' из предыдущей БД.' : ' из .env.'));

        // Квоты классов моделей GigaChat (freemium: у каждого класса свой лимит)
        const { GIGACHAT_MODELS } = require('./ai_models');
        for (const m of GIGACHAT_MODELS) {
            await db.query(
                'INSERT INTO ai_usage (model_class, model_id, quota) VALUES ($1, $2, $3) ON CONFLICT (model_class) DO NOTHING',
                [m.class, m.id, m.quota]
            );
        }

        // Тестовый администратор
        await db.query(`
            INSERT INTO operator_codes (code, admin_name)
            VALUES ('ADMIN-MAIN', 'Администратор')
            ON CONFLICT DO NOTHING;
        `);

        // Загрузка из файла
        const jsonPath = path.join(__dirname, 'faq_data.json');
        if (fs.existsSync(jsonPath)) {
            console.log('Загрузка данных из faq_data.json...');
            const faqData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

            for (const item of faqData) {
                const keywordsStr = (Array.isArray(item.keywords) ? item.keywords : (item.keywords || '').split(','))
                    .map(k => k.trim())
                    .filter(k => k.length > 0)
                    .join(', ');

                await db.query(
                    `INSERT INTO faq (category, question, answer, keywords) VALUES ($1, $2, $3, $4)`,
                    [item.category, item.question, item.answer, keywordsStr]
                );
            }
        }

        console.log('ГОТОВО! База пересоздана с нуля.');

    } catch (err) {
        console.error('Ошибка:', err);
        process.exitCode = 1;
    } finally {
        await db.end();
    }
}

runMigration();