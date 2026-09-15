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
const rateLimit = require('express-rate-limit');

// Ограничение: максимум 100 запросов с одного IP в минуту
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 минута
    max: 100, // Ограничение каждого IP до 100 запросов за окно (1 минута)
    message: 'Слишком много запросов с вашего IP, пожалуйста, подождите минуту.'
});

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // 'unsafe-inline' пока нужен для блоков <script> внутри шаблонов.
            // Обработчики в атрибутах (onclick=…) уже убраны и запрещены через
            // script-src-attr 'none' (его helmet ставит сам) — именно так
            // выполнялись внедрённые onerror=… при XSS. Следующий шаг — nonce.
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            // Главное здесь: даже если XSS всё-таки случится, увести данные
            // на чужой сервер не выйдет — сеть разрешена только на свой origin.
            connectSrc: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            // Панель пока отдаётся по HTTP, принудительный апгрейд её сломает
            upgradeInsecureRequests: null
        }
    }
}));
app.use(limiter);
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.json({ limit: '50mb' }));
// Путь от файла, а не от текущей директории: иначе запуск не из папки проекта
// оставляет админку без стилей и скриптов
app.use(express.static(path.join(__dirname, 'public')));

// Без этих секретов приложение не должно подниматься вообще:
// пустой ADMIN_PASS раньше пускал в панель любого (undefined === undefined),
// а предсказуемый SESSION_SECRET позволяет подделать cookie администратора.
const requiredSecrets = ['ADMIN_PASS', 'SESSION_SECRET'];
const missingSecrets = requiredSecrets.filter(name => !process.env[name] || process.env[name].trim() === '');
if (missingSecrets.length > 0) {
    console.error(`[SECURITY] Не заданы обязательные переменные окружения: ${missingSecrets.join(', ')}`);
    console.error('[SECURITY] Добавьте их в .env и перезапустите. Запуск прерван.');
    process.exit(1);
}
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production'
    }
}));

// 6. Защита от CSRF (synchronizer token)
// Токен хранится в сессии администратора; любая изменяющая операция обязана
// вернуть его — в скрытом поле формы (_csrf) или в заголовке X-CSRF-Token.
const crypto = require('crypto');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

app.use((req, res, next) => {
    if (req.session.isAdmin && !req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken || '';

    // Форма входа исключена: сессии администратора там ещё нет,
    // а подделать вход, не зная пароля, всё равно невозможно.
    if (SAFE_METHODS.has(req.method) || req.path === '/login') return next();

    const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
    const expected = req.session.csrfToken;

    const valid = typeof sent === 'string' && typeof expected === 'string' &&
        sent.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));

    if (!valid) {
        console.warn(`[SECURITY] Отклонён запрос без валидного CSRF-токена: ${req.method} ${req.path} с IP ${req.ip}`);
        return res.status(403).send('Запрос отклонён: сессия устарела или форма отправлена со стороннего сайта. Обновите страницу и повторите.');
    }

    next();
});

// 7. Подключение маршрутов админки
app.use('/', adminRoutes);

// 8. Функция запуска ботов для всех активных групп
async function startBots() {
    try {
        const groups = await db.query('SELECT * FROM vk_groups WHERE is_active = TRUE');

        if (groups.rows.length === 0) {
            console.log('⚠️ Нет активных групп VK. Добавьте группы через админку: /groups');
            return;
        }

        const allowed = createBotInstance.getAllowedGroupIds();
        if (allowed.length > 0) {
            console.info(`[BOT] Локальный режим: подключаемся только к группам ${allowed.join(', ')} (ALLOWED_GROUP_IDS)`);
        }

        for (const group of groups.rows) {
            if (!createBotInstance.isGroupAllowed(group.group_id)) {
                console.info(`[BOT] Пропущена группа ${group.group_name} (ID: ${group.group_id}) — нет в ALLOWED_GROUP_IDS`);
                continue;
            }
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

// 9. Главная функция запуска
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
            
            // Запуск frpc-туннеля без Docker — ТОЛЬКО по явному флагу.
            // Раньше frpc.exe стартовал автоматически, если лежал в папке, и при
            // локальном тестировании публиковал админку на тот же сервер и под
            // тем же именем, что и продовый туннель. В проде туннель работает
            // в отдельном контейнере docker compose, флаг ему не нужен.
            const fs = require('fs');
            const { spawn } = require('child_process');
            const frpcPath = path.join(__dirname, 'frpc.exe');
            const frpcConfig = path.join(__dirname, 'frpc.toml');

            if (process.env.ENABLE_FRPC === 'true' && fs.existsSync(frpcPath)) {
                console.info('[FRPC] Запускаем проброс портов...');
                const frp = spawn(frpcPath, ['-c', frpcConfig]);
                frp.stdout.on('data', data => console.info(`[FRPC] ${data.toString().trim()}`));
                frp.stderr.on('data', data => console.warn(`[FRPC] ${data.toString().trim()}`));
                // Без обработчика ошибка запуска (нет файла, нет прав) роняет процесс
                frp.on('error', err => console.error('[FRPC] Не удалось запустить туннель:', err));
            } else if (fs.existsSync(frpcPath)) {
                console.info('[FRPC] Туннель выключен — работаем только на localhost (для включения ENABLE_FRPC=true)');
            }
        });

    } catch (err) {
        console.error('Ошибка при запуске:', err);
    }
}

// 10. ЗАПУСК
start();