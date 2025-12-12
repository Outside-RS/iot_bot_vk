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

async function updateFaq() {
    try {
        await db.connect();
        console.log('Синхронизация FAQ...');

        const jsonPath = path.join(__dirname, 'faq_data.json');
        const faqData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        let added = 0;
        let updated = 0;

        for (const item of faqData) {
            const checkRes = await db.query('SELECT id, answer, keywords FROM faq WHERE question = $1', [item.question]);

            if (checkRes.rows.length > 0) {
                // Если вопрос есть, проверяем, изменился ли ответ или КЛЮЧЕВЫЕ СЛОВА
                const row = checkRes.rows[0];
                const newKeywords = Array.isArray(item.keywords) ? item.keywords.join(' ') : (item.keywords || '');

                // Сравниваем ответ и ключевые слова
                if (row.answer !== item.answer || row.keywords !== newKeywords) {
                    await db.query(
                        'UPDATE faq SET answer = $1, category = $2, keywords = $3 WHERE id = $4',
                        [item.answer, item.category, newKeywords, row.id]
                    );
                    console.log(`Обновлено: "${item.question}"`);
                    updated++;
                }
            } else {
                // Добавляем новый
                const textForVector = item.question + (item.keywords ? " " + keywordsStr : "");
                const vector = await getEmbedding(textForVector);

                await db.query(
                    `INSERT INTO faq (category, question, answer, keywords, embedding) VALUES ($1, $2, $3, $4, $5)`,
                    [item.category, item.question, item.answer, keywordsStr, vector ? JSON.stringify(vector) : null]
                );
                console.log(`Добавлено: "${item.question}"`);
                added++;
            }
        }

        console.log(`Готово! Добавлено: ${added}, Обновлено: ${updated}`);

    } catch (err) {
        console.error(err);
    } finally {
        await db.end();
    }
}

updateFaq();