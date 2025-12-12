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

async function getEmbedding(text) {
    try {
        const response = await fetch('http://127.0.0.1:11434/api/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'nomic-embed-text', prompt: text })
        });
        const data = await response.json();
        return data.embedding;
    } catch (e) {
        return null;
    }
}

async function runMigration() {
    try {
        await db.connect();
        console.log('Подключение к БД...');

        await db.query('CREATE EXTENSION IF NOT EXISTS vector;');

        console.log('Очистка таблиц...');
        await db.query(`
            DROP TABLE IF EXISTS messages CASCADE;
            DROP TABLE IF EXISTS tickets CASCADE;
            DROP TABLE IF EXISTS faq CASCADE;
            DROP TABLE IF EXISTS users CASCADE;
            DROP TABLE IF EXISTS operator_codes CASCADE;
        `);

        console.log('Создание новой структуры...');

        await db.query(`
            CREATE TABLE operator_codes (
                code TEXT PRIMARY KEY,
                tutor_name TEXT NOT NULL,
                allowed_groups TEXT[]
            );

            CREATE TABLE users (
                vk_id BIGINT PRIMARY KEY,
                role TEXT DEFAULT 'student',
                full_name TEXT,
                group_number TEXT,
                linked_code TEXT,
                state TEXT DEFAULT 'registration_start',
                current_chat_ticket_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE faq (
                id SERIAL PRIMARY KEY,
                category TEXT,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                keywords TEXT, -- НОВОЕ ПОЛЕ: Скрытые теги
                
                -- ОБНОВЛЕННЫЙ ИНДЕКС: Ищем в вопросе + ответе + ключевых словах
                -- COALESCE нужен, чтобы если keywords пустые, поиск не ломался
                search_vector TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('russian', question || ' ' || answer || ' ' || COALESCE(keywords, ''))
                ) STORED,
                
                embedding vector(768)
            );
            
            CREATE INDEX faq_search_idx ON faq USING GIN (search_vector);
            -- Индекс для векторов убран (для точности на малых данных)

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

        // Тестовый тьютор
        await db.query(`
            INSERT INTO operator_codes (code, tutor_name, allowed_groups)
            VALUES ('TUTOR-RIOT', 'Тьютор Анна', '{"РИ-140944", "РИ-140945"}')
            ON CONFLICT DO NOTHING;
        `);

        // Загрузка из файла
        const jsonPath = path.join(__dirname, 'faq_data.json');
        if (fs.existsSync(jsonPath)) {
            console.log('Загрузка данных из faq_data.json...');
            const faqData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

            for (const item of faqData) {
                // Генерируем вектор только по вопросу (или вопрос + ключевые слова, чтобы улучшить и векторный поиск тоже)
                // Давай добавим keywords и в вектор, это улучшит поиск по смыслу!
                // Превращаем массив в строку, если это массив
                const keywordsStr = Array.isArray(item.keywords) ? item.keywords.join(' ') : (item.keywords || '');
                const textForVector = item.question + " " + keywordsStr;
                const vector = await getEmbedding(textForVector);

                await db.query(
                    `INSERT INTO faq (category, question, answer, keywords, embedding) VALUES ($1, $2, $3, $4, $5)`,
                    [item.category, item.question, item.answer, keywordsStr, vector ? JSON.stringify(vector) : null]
                );
            }
        }

        console.log('ГОТОВО! База обновлена (Keywords + No Index).');

    } catch (err) {
        console.error('Ошибка:', err);
    } finally {
        await db.end();
    }
}

runMigration();