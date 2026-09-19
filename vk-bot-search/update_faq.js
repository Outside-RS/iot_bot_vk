// Загрузка базы знаний из файла faq_data.json в таблицу faq.
//
//   node update_faq.js
//
// Дополняет базу, а не заменяет: запись с тем же вопросом обновляется,
// остальные остаются на месте. Поэтому скрипт безопасно запускать повторно
// и на рабочей базе — в отличие от reset_db.js, который всё удаляет.
//
// То же самое умеет кнопка «Импорт» в админке, раздел «База знаний».
// Скрипт оставлен для случая, когда панель недоступна.
require('dotenv').config({ quiet: true });
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
            // Совпадение ищем по тексту вопроса: своих идентификаторов у записей
            // в файле нет, а вопрос — единственное, что их различает
            const checkRes = await db.query('SELECT id, answer, keywords FROM faq WHERE question = $1', [item.question]);

            // Ключевые слова в файле бывают и массивом, и строкой через запятую.
            // Приводим к одному виду, иначе сравнение ниже посчитает изменением
            // даже одинаковый по смыслу список
            const newKeywords = (Array.isArray(item.keywords) ? item.keywords : (item.keywords || '').split(','))
                .map(k => k.trim())
                .filter(k => k.length > 0)
                .join(', ');

            if (checkRes.rows.length > 0) {
                // Запись уже есть: трогаем её, только если ответ или ключевые
                // слова изменились — иначе в журнале будет шум на всю базу
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
        console.error('Ошибка загрузки базы знаний:', err.message);
        process.exitCode = 1;
    } finally {
        await db.end();
    }
}

updateFaq();