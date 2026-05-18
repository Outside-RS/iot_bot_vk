require('dotenv').config();
require('./logger');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const path = require('path');

// 1. Импорт модулей
const createBotInstance = require('./bot');
const adminRoutes = require('./routes/admin');
const { db } = require('./database');

// 2. Создание приложения Express
const app = express();
const PORT = 3000;

// 3. Глобальное хранилище запущенных ботов
global.bots = {};

// 4. Настройка шаблонизатора (EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 5. Настройка Middleware
// Нужен при деплое за Nginx/Docker — позволяет rate-limiter видеть реальный IP клиента,
// а не IP прокси. Без этого все запросы выглядят с одного адреса.
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

if (!process.env.SESSION_SECRET) {
    console.warn('[SECURITY] SESSION_SECRET не задан в .env — используется небезопасный default');
}
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production'
    }
}));

// 6. Подключение маршрутов админки
app.use('/', adminRoutes);

// 7. Функция запуска ботов для всех активных групп
async function startBots() {
    try {
        const groups = await db.query('SELECT * FROM vk_groups WHERE is_active = TRUE');

        if (groups.rows.length === 0) {
            console.log('⚠️ Нет активных групп VK. Добавьте группы через админку: /groups');
            return;
        }

        for (const group of groups.rows) {
            try {
                const botInstance = createBotInstance(
                    group.access_token,
                    group.group_id,
                    group.group_name
                );

                await botInstance.updates.start();

                // Сохраняем в глобальный объект
                global.bots[group.group_id] = botInstance;

                console.log(`🚀 Бот запущен: ${group.group_name} (ID: ${group.group_id})`);
            } catch (e) {
                console.error(`❌ Ошибка запуска группы ${group.group_name}:`, e.message);
            }
        }

        console.log(`✅ Всего запущено ботов: ${Object.keys(global.bots).length}`);
    } catch (e) {
        console.error('Ошибка загрузки групп:', e);
    }
}

// 8. Главная функция запуска
async function start() {
    try {
        // Запускаем ботов для всех групп
        await startBots();

        // Запускаем AI Worker
        const { startWorker } = require('./ai_worker');
        startWorker();

        // Запускаем веб-сервер
        app.listen(PORT, () => {
            console.log(`🌍 Админка доступна: http://localhost:${PORT}`);
        });

    } catch (err) {
        console.error('Ошибка при запуске:', err);
    }
}

// 9. ЗАПУСК
start();