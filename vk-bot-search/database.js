require('dotenv').config();
const { Client } = require('pg');

const db = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

// Подключаемся сразу при импорте файла
db.connect()
    .then(() => console.log('📦 База данных подключена (database.js)'))
    .catch(e => console.error('Ошибка БД', e));

module.exports = { db };