require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

// 1. Импорт модулей (Бот и Админка)
const startBot = require('./bot');
const adminRoutes = require('./routes/admin');

// 2. Создание приложения Express
const app = express();
const PORT = 3000;

// 3. Настройка шаблонизатора (EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 4. Настройка Middleware (обработка форм и сессии)
app.use(express.urlencoded({ extended: true })); // Чтобы читать POST-запросы
app.use(express.static('public')); // Папка для CSS/картинок

app.use(session({
    secret: 'secret_key_123', // Можно поменять на любой набор букв
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 часа
}));

// 5. Подключение маршрутов админки
app.use('/', adminRoutes);

// 6. Функция запуска (Бот + Сайт)
async function start() {
    try {
        // Сначала запускаем бота
        await startBot();

        // Потом запускаем сайт
        app.listen(PORT, () => {
            console.log(`🌍 Админка доступна: http://localhost:${PORT}`);
        });

    } catch (err) {
        console.error('Ошибка при запуске:', err);
    }
}

// 7. ЗАПУСК (Строго в конце файла!)
start();