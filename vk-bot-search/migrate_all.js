require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const db = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

async function runMigration() {
    try {
        await db.connect();
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
            DROP TABLE IF EXISTS app_settings CASCADE;
        `);

        console.log('Создание новой структуры...');

        await db.query(`
            CREATE TABLE vk_groups (
                id SERIAL PRIMARY KEY,
                group_id BIGINT UNIQUE NOT NULL,
                group_name TEXT NOT NULL,
                access_token TEXT NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW()
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX idx_ai_queue_status ON ai_queue(status);

            CREATE TABLE faq (
                id SERIAL PRIMARY KEY,
                category TEXT,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                keywords TEXT,
                
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
                operator_vk_id BIGINT,
                question TEXT NOT NULL,
                status TEXT DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
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

        console.log('ГОТОВО! База обновлена (Opt: NoVectors, NoAnswersInSearch, PgTrgm).');

    } catch (err) {
        console.error('Ошибка:', err);
    } finally {
        await db.end();
    }
}

runMigration();