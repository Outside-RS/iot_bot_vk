// Скрипт для создания таблицы app_settings и переноса ключа GigaChat из .env
require('dotenv').config();
const { Client } = require('pg');

const c = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT
});

(async () => {
    await c.connect();

    await c.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
            id BOOLEAN PRIMARY KEY DEFAULT TRUE,
            ollama_url TEXT DEFAULT 'http://127.0.0.1:11434',
            ollama_model TEXT DEFAULT 'qwen2.5:7b',
            gigachat_key TEXT,
            gigachat_scope TEXT DEFAULT 'GIGACHAT_API_PERS',
            gigachat_model TEXT DEFAULT 'GigaChat-2'
        )
    `);

    await c.query(
        `INSERT INTO app_settings (id, gigachat_key, gigachat_scope)
         VALUES (TRUE, $1, $2)
         ON CONFLICT (id) DO UPDATE SET gigachat_key = $1, gigachat_scope = $2`,
        [process.env.GIGACHAT_AUTH_KEY || null, process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS']
    );

    const r = await c.query('SELECT * FROM app_settings');
    console.log('✅ app_settings создана:', JSON.stringify(r.rows[0], null, 2));

    await c.end();
})();
