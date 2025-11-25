require('dotenv').config();
const { VK } = require('vk-io');
const { Client } = require('pg');

// 1. Настройка подключения к ВКонтакте
const vk = new VK({
    token: process.env.VK_TOKEN
});

// 2. Настройка подключения к Базе Данных
const db = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432, // Добавили порт для надежности
});

// 3. Логика обработки сообщений
vk.updates.on('message_new', async (context) => {
    // Защита от автоответов самому себе
    if (context.isOutbox) return;

    const userText = context.text;

    if (!userText) return; // Если прислали картинку без текста

    console.log(`Сообщение от пользователя: ${userText}`);

    try {
        // --- SQL ЗАПРОС (Умный поиск) ---
        // plainto_tsquery превращает обычный текст в запрос для поиска
        // ts_rank_cd сортирует результаты по релевантности (Cover Density)
        const query = `
            SELECT answer, ts_rank_cd(search_vector, plainto_tsquery('russian', $1)) as rank
            FROM faq
            WHERE search_vector @@ plainto_tsquery('russian', $1)
            ORDER BY rank DESC
            LIMIT 1;
        `;

        const res = await db.query(query, [userText]);
        const photo = await vk.upload.messagePhoto({
            source: {
                value: ''
            }
        });

        if (res.rows.length > 0) {
            // Нашли ответ в базе
            await context.send(res.rows[0].answer);
            console.log('Ответ найден в базе');
        } else {
            // Не нашли ответ
            await context.send({
                message: 'Я пока не знаю ответа на этот вопрос. Перевожу на оператора...',
                attachment: photo
            });

            console.log('Ответ не найден -> Оператор');
        }

    } catch (err) {
        console.error('Ошибка базы данных:', err);
        await context.send('Произошла техническая ошибка.');
    }
});

// Функция запуска
async function start() {
    try {
        // Подключаемся к БД
        await db.connect();
        console.log('База данных подключена');

        // Подключаемся к ВК (Long Poll)
        await vk.updates.start();
        console.log('Бот запущен и ждет сообщений...');

    } catch (err) {
        console.error('Ошибка запуска:', err);
    }
}

start();
