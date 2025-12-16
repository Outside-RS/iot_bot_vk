require('dotenv').config();
const { Client } = require('pg');

const db = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

// Функция векторов (экспортируем её, чтобы юзать везде)
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
        console.error('⚠️ Ollama Error:', e.message);
        return null;
    }
}

// Подключаемся сразу при импорте файла
db.connect().then(() => console.log('📦 База данных подключена (database.js)')).catch(e => console.error('Ошибка БД', e));

module.exports = { db, getEmbedding };