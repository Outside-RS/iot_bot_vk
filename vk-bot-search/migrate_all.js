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

        console.log('Очистка таблиц...');
        await db.query(`
            DROP TABLE IF EXISTS messages CASCADE;
            DROP TABLE IF EXISTS tickets CASCADE;
            DROP TABLE IF EXISTS faq CASCADE;
            DROP TABLE IF EXISTS users CASCADE;
            DROP TABLE IF EXISTS operator_codes CASCADE;
            DROP TABLE IF EXISTS vk_groups CASCADE;
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
        `);

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
                const keywordsStr = Array.isArray(item.keywords) ? item.keywords.join(' ') : (item.keywords || '');

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