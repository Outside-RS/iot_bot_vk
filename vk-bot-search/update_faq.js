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

async function updateFaq() {
    try {
        await db.connect();
        console.log('Синхронизация FAQ...');

        const jsonPath = path.join(__dirname, 'faq_data.json');
        if (!fs.existsSync(jsonPath)) {
            console.error('Файл faq_data.json не найден!');
            return;
        }

        const faqData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        let added = 0;
        let updated = 0;

        for (const item of faqData) {
            // Ищем по вопросу
            const checkRes = await db.query('SELECT id, answer, keywords FROM faq WHERE question = $1', [item.question]);

            const newKeywords = Array.isArray(item.keywords) ? item.keywords.join(' ') : (item.keywords || '');

            if (checkRes.rows.length > 0) {
                // Если вопрос есть, проверяем изменения
                const row = checkRes.rows[0];

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
                await db.query(
                    'INSERT INTO faq (category, question, answer, keywords) VALUES ($1, $2, $3, $4)',
                    [item.category, item.question, item.answer, newKeywords]
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