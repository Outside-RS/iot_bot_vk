// Обновление СУЩЕСТВУЮЩЕЙ базы до текущей версии кода.
//
// Скрипт идемпотентный: каждое изменение проверяет, не сделано ли оно уже,
// поэтому его можно запускать повторно и на любой базе — старой, новой,
// частично обновлённой. Данные не удаляются.
//   node migrate_update.js
//
// Для чистой установки с нуля — migrate_all.js (он УДАЛЯЕТ все таблицы).
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { GIGACHAT_MODELS } = require('./ai_models');
const { parseCommunityName, describeCommunity } = require('./courses');

const c = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT
});

(async () => {
    await c.connect();

    // ── Очередь ИИ ─────────────────────────────────────────────
    // Момент взятия задачи в работу. Раньше «зависшие» задачи искали по
    // created_at — времени постановки в очередь, из-за чего задача, пролежавшая
    // в очереди дольше 10 минут, сбрасывалась сразу после взятия и обрабатывалась дважды.
    await c.query('ALTER TABLE ai_queue ADD COLUMN IF NOT EXISTS started_at TIMESTAMP');

    // ── Пользователи ───────────────────────────────────────────
    // Фото, присланные до вопроса (появились 14.06.2026 с обработкой фото).
    // Код использует колонку, но ни один скрипт её не создавал: на базах, где её
    // не добавили вручную, кнопка «Передать администратору» падала с ошибкой 42703.
    await c.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_attachments JSONB');

    // Перевод курса ищет студентов по сообществу
    await c.query('CREATE INDEX IF NOT EXISTS idx_users_vk_group ON users(vk_group_id)');

    // ── Учёт токенов GigaChat ──────────────────────────────────
    // Во freemium-режиме квоты у классов моделей независимые — считаем по каждому.
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

    // ── Курсы VK-сообществ (Этап 6) ────────────────────────────
    // Курс сообщества берётся из названия: «Второй курс …» → 2, «… Архив 25/26» → выпуск.
    await c.query('ALTER TABLE vk_groups ADD COLUMN IF NOT EXISTS course INTEGER');
    await c.query('ALTER TABLE vk_groups ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE');
    await c.query('ALTER TABLE vk_groups ADD COLUMN IF NOT EXISTS name_synced_at TIMESTAMP');

    // Начальное значение — из сохранённого названия. Оно могло устареть (группу
    // добавили до летнего переименования) — это нормально: первая сверка с VK
    // заметит смену курса и переведёт студентов, как при обычном переименовании.
    const groups = await c.query('SELECT id, group_name FROM vk_groups WHERE course IS NULL AND name_synced_at IS NULL');
    for (const g of groups.rows) {
        const parsed = parseCommunityName(g.group_name);
        await c.query('UPDATE vk_groups SET course = $1, is_archived = $2 WHERE id = $3', [parsed.course, parsed.archived, g.id]);
    }

    // ── Итог ───────────────────────────────────────────────────
    console.log('✅ База обновлена до текущей версии.');
    const usage = await c.query('SELECT model_id, tokens_used, quota FROM ai_usage ORDER BY quota DESC');
    console.table(usage.rows);
    const vk = await c.query('SELECT group_id, group_name, course, is_archived FROM vk_groups ORDER BY group_id');
    console.table(vk.rows.map(r => ({ ...r, 'как понял бот': describeCommunity({ course: r.course, archived: r.is_archived }) })));

    await c.end();
})().catch(err => {
    console.error('❌ Ошибка обновления базы:', err.message);
    process.exit(1);
});
