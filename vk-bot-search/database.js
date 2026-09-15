require('dotenv').config();
const { Pool } = require('pg');

const db = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

// ОБЯЗАТЕЛЬНЫЙ обработчик: когда PostgreSQL останавливается или рвёт связь,
// простаивающие соединения пула получают ошибку (например 57P01 «terminating
// connection due to administrator command»), и пул генерирует событие 'error'.
// Необработанное событие 'error' в Node.js завершает процесс — бот падал целиком
// при любом перезапуске базы. Сломанное соединение пул выбрасывает сам,
// а при следующем запросе откроет новое, как только база вернётся.
db.on('error', (err) => {
    console.error(`[DB] Потеряно соединение с базой (${err.code || 'без кода'}): ${err.message}`);
});

// Проверяем подключение при импорте
db.query('SELECT 1')
    .then(() => console.log('📦 База данных подключена (database.js)'))
    .catch(e => console.error('[DB] Нет подключения к базе при старте:', e.message));

module.exports = { db };