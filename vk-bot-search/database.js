require('dotenv').config();
const { Pool } = require('pg');

const db = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

// Проверяем подключение при импорте
db.query('SELECT 1')
    .then(() => console.log('📦 База данных подключена (database.js)'))
    .catch(e => console.error('Ошибка БД', e));

module.exports = { db };