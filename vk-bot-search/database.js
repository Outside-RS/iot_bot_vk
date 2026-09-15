require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

const db = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

// ==================== Журнал связи с базой ====================

// Запросы дольше порога попадают в лог как предупреждение (DB_SLOW_QUERY_MS в .env)
const SLOW_QUERY_MS = Number(process.env.DB_SLOW_QUERY_MS) || 500;

// Состояние связи. Пока база лежит, каждый запрос падает с одной и той же
// ошибкой — логируем её один раз на весь эпизод, а не каждые три секунды,
// и отдельно отмечаем момент восстановления.
let connectionLost = false;

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', '57P01', '57P02', '57P03']);

function isConnectionError(err) {
    return CONNECTION_CODES.has(err.code) ||
        (typeof err.code === 'string' && err.code.startsWith('08')) || // класс 08 — ошибки соединения PostgreSQL
        /Connection terminated|connection timeout/i.test(err.message || '');
}

function reportConnectionLost(err) {
    if (connectionLost) return;
    connectionLost = true;
    // Объект ошибки передаём целиком: логгер сам достанет текст,
    // в том числе из вложенных ошибок AggregateError
    console.error('[DB] Нет связи с базой:', err, '— пока связь не вернётся, повторные ошибки не логируются.');
}

function reportConnectionOk() {
    if (!connectionLost) return;
    connectionLost = false;
    console.info('[DB] Соединение с базой восстановлено');
}

const sqlPreview = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 140);

// Обёртка над db.query: время выполнения, медленные запросы, ошибки с текстом SQL.
// Все запросы приложения идут через неё — это единая точка наблюдения за базой.
const rawQuery = db.query.bind(db);
db.query = async (text, params) => {
    const started = Date.now();
    try {
        const res = await rawQuery(text, params);
        reportConnectionOk();
        const ms = Date.now() - started;
        if (ms >= SLOW_QUERY_MS) {
            console.warn(`[DB] Медленный запрос: ${ms} мс — ${sqlPreview(text)}`);
        }
        return res;
    } catch (err) {
        if (isConnectionError(err)) {
            reportConnectionLost(err);
        } else {
            console.error('[DB] Ошибка запроса:', err, `— ${sqlPreview(text)}`);
        }
        throw err;
    }
};

// ОБЯЗАТЕЛЬНЫЙ обработчик: когда PostgreSQL останавливается или рвёт связь,
// простаивающие соединения пула получают ошибку (например 57P01 «terminating
// connection due to administrator command»), и пул генерирует событие 'error'.
// Необработанное событие 'error' в Node.js завершает процесс — бот падал целиком
// при любом перезапуске базы. Сломанное соединение пул выбрасывает сам,
// а при следующем запросе откроет новое, как только база вернётся.
db.on('error', reportConnectionLost);

// Проверяем подключение при импорте
db.query('SELECT 1')
    .then(() => console.info(`[DB] Подключено к базе ${process.env.DB_NAME || ''} на ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`))
    .catch(() => { /* причина уже записана обёрткой db.query */ });

module.exports = { db, reportConnectionLost, reportConnectionOk, _test: { isConnectionError } };
