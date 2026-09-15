// Обновление существующей базы для Этапа 3 (очередь ИИ и учёт токенов GigaChat).
// Скрипт идемпотентный — можно запускать повторно, данные не удаляются.
//   node migrate_ai_stage3.js
require('dotenv').config();
const { Client } = require('pg');
const { GIGACHAT_MODELS } = require('./ai_models');

const c = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT
});

(async () => {
    await c.connect();

    // Момент взятия задачи в работу. Раньше «зависшие» задачи искали по
    // created_at — времени постановки в очередь, из-за чего задача, пролежавшая
    // в очереди дольше 10 минут, сбрасывалась сразу после взятия и обрабатывалась дважды.
    await c.query('ALTER TABLE ai_queue ADD COLUMN IF NOT EXISTS started_at TIMESTAMP');

    // Учёт токенов GigaChat. Во freemium-режиме квоты у классов моделей
    // независимые — считаем по каждому.
    await c.query(`
        CREATE TABLE IF NOT EXISTS ai_usage (
            model_class TEXT PRIMARY KEY,
            model_id    TEXT NOT NULL,
            tokens_used BIGINT NOT NULL DEFAULT 0,
            quota       BIGINT NOT NULL,
            exhausted   BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    for (const m of GIGACHAT_MODELS) {
        // Квоту у существующей строки не трогаем: её уточняет сверка с балансом Сбера
        await c.query(
            `INSERT INTO ai_usage (model_class, model_id, quota) VALUES ($1, $2, $3)
             ON CONFLICT (model_class) DO UPDATE SET model_id = EXCLUDED.model_id`,
            [m.class, m.id, m.quota]
        );
    }

    console.log('✅ База обновлена.');
    const usage = await c.query('SELECT model_id, tokens_used, quota FROM ai_usage ORDER BY quota DESC');
    console.table(usage.rows);
    await c.end();
})().catch(err => {
    console.error('❌ Ошибка обновления базы:', err.message);
    process.exit(1);
});
