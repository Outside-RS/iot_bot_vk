require('dotenv').config({ quiet: true });
// Логгер ставится первым: перехватывает console.* во всём приложении
require('./logger').install();
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
// На проде перед ботом стоит Caddy (HTTPS, см. Caddyfile): доверяем одному
// прокси — берём IP клиента из X-Forwarded-For и протокол из X-Forwarded-Proto.
// Без этого rate-limiter видел бы все запросы с одного адреса — адреса Caddy.
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
            // На проде HTTP → HTTPS перенаправляет Caddy. Здесь апгрейд не включаем:
            // локально панель открывается по http://localhost, и он бы её сломал
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

// Сессии администраторов хранятся в PostgreSQL (таблица session), а не в памяти
// процесса. Раньше каждый перезапуск бота — деплой, сбой, docker restart —
// разлогинивал всех, а хранилище в памяти, по документации express-session,
// не чистит истёкшие сессии и «не предназначено для продакшена».
const PgSessionStore = require('connect-pg-simple')(session);
const sessionStore = new PgSessionStore({
    pool: db,                     // тот же пул соединений, что у всего приложения
    tableName: 'session',
    createTableIfMissing: true,   // таблицу создают и скрипты базы; это страховка
    pruneSessionInterval: 15 * 60, // истёкшие сессии удаляются раз в 15 минут
    errorLog: (...args) => console.error('[SESSION]', ...args)
});

app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'strict',
        // Cookie с флагом Secure, когда запрос пришёл по HTTPS: на проде это
        // сообщает Caddy (X-Forwarded-Proto, см. trust proxy выше). Локально по
        // http://localhost флаг не ставится, иначе браузер не вернул бы cookie
        // и вход не работал бы. Раньше флаг зависел от NODE_ENV, который нигде
        // не задавался, — и за HTTPS cookie осталась бы без флага Secure.
        secure: 'auto'
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
            console.warn('[BOT] Нет активных групп VK. Добавьте группы через админку: /groups');
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

                console.info(`[BOT] Бот запущен: ${group.group_name} (ID: ${group.group_id})`);
            } catch (e) {
                console.error(`[BOT] Не удалось запустить группу ${group.group_name} (ID: ${group.group_id}):`, e);
            }
        }

        console.info(`[BOT] Всего запущено ботов: ${Object.keys(global.bots).length}`);
        startPollingWatchdog();
    } catch (e) {
        console.error('[BOT] Не удалось загрузить список групп из базы:', e);
    }
}

// Присмотр за подключениями к сообществам.
//
// Подключение к ВКонтакте может оборваться и не подняться: сеть пропала
// надолго, токен отозвали, сообщество заблокировали. Процесс бота при этом жив
// и здоров, админка работает, копии делаются — а студенты одного курса просто
// перестают получать ответы, и заметить это можно только по жалобам.
//
// Раз в пять минут проверяем каждое подключение и поднимаем упавшие.
let pollingWatchdog = null;
const POLLING_CHECK_MS = 5 * 60 * 1000;

function startPollingWatchdog() {
    if (pollingWatchdog) return;
    pollingWatchdog = setInterval(async () => {
        for (const [groupId, bot] of Object.entries(global.bots || {})) {
            if (bot.updates.isStarted) continue;
            console.warn(`[BOT] Подключение к сообществу ${groupId} не активно — поднимаем заново`);
            try {
                await bot.updates.start();
                console.info(`[BOT] Подключение к сообществу ${groupId} восстановлено`);
            } catch (err) {
                // Токен отозван или сообщество заблокировано — сами не починим,
                // но в журнале это теперь видно, а не тишина
                console.error(`[BOT] Не удалось восстановить подключение к ${groupId}:`, err.message);
            }
        }
    }, POLLING_CHECK_MS);
    pollingWatchdog.unref();
}

// 9. Главная функция запуска
async function start() {
    try {
        const logger = require('./logger').getLogger();
        console.info(`[APP] Запуск. Уровень логов: ${process.env.LOG_LEVEL || 'debug'}, часовой пояс: ${process.env.LOG_TIMEZONE || 'Asia/Yekaterinburg'}, файлы логов хранятся ${process.env.LOG_RETENTION_DAYS || 14} дн.${logger ? '' : ' (логгер не установлен!)'}`);

        // Запускаем ботов для всех групп
        await startBots();

        // Запускаем AI Worker
        const { startWorker } = require('./ai_worker');
        startWorker();

        // Плановая сверка названий сообществ и перевод курса (1 августа и 1 сентября)
        require('./group_sync').scheduleGroupSync();

        // Запускаем веб-сервер
        httpServer = app.listen(PORT, () => {
            console.info(`[APP] Админка доступна: http://localhost:${PORT}`);
            
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
                frpProcess = frp;
                frp.stdout.on('data', data => console.info(`[FRPC] ${data.toString().trim()}`));
                frp.stderr.on('data', data => console.warn(`[FRPC] ${data.toString().trim()}`));
                // Без обработчика ошибка запуска (нет файла, нет прав) роняет процесс
                frp.on('error', err => console.error('[FRPC] Не удалось запустить туннель:', err));
            } else if (fs.existsSync(frpcPath)) {
                console.info('[FRPC] Туннель выключен — работаем только на localhost (для включения ENABLE_FRPC=true)');
            }
        });

    } catch (err) {
        console.error('[APP] Ошибка при запуске:', err);
    }
}

// 10. Корректная остановка (docker stop, Ctrl+C, перезапуск)
// Раньше процесс обрывался на полуслове: задача ИИ, которая была в работе,
// висела «в работе» 10 минут до зомби-чистильщика, а последние строки лога
// могли не дописаться в файл. Docker ждёт 10 секунд — укладываемся в 8.
let httpServer = null;
let frpProcess = null;
let shuttingDown = false;

async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[APP] Остановка: ${reason}`);

    const force = setTimeout(() => {
        console.error('[APP] Не уложились в 8 секунд — завершаем принудительно');
        process.exit(exitCode || 1);
    }, 8000);
    force.unref();

    const step = async (name, fn) => {
        try { await fn(); } catch (err) { console.error(`[APP] Остановка: ошибка на шаге «${name}»:`, err); }
    };

    // 1. Админка перестаёт принимать новые запросы
    await step('веб-сервер', () => new Promise(resolve => {
        if (!httpServer) return resolve();
        httpServer.close(() => resolve());
        httpServer.closeIdleConnections(); // страница логов держит соединение открытым
    }));

    // 2. Боты отключаются от VK — новые сообщения больше не приходят.
    // Сторож гасим первым, иначе он поднимет их обратно
    if (pollingWatchdog) { clearInterval(pollingWatchdog); pollingWatchdog = null; }
    await step('боты VK', () => Promise.allSettled(Object.values(global.bots || {}).map(bot => bot.updates.stop())));

    // 3. Очередь ИИ: ждём задачи в работе, недоделанные возвращаем в очередь
    await step('очередь ИИ', () => require('./ai_worker').stopWorker(4000));

    // 4. Плановые задания, чистка сессий и туннель
    await step('расписание', () => require('node-schedule').gracefulShutdown());
    await step('сессии', () => sessionStore.close());
    await step('туннель', () => { if (frpProcess) frpProcess.kill(); });

    // 5. Соединения с базой и запись логов на диск
    await step('база', () => db.end());
    console.info('[APP] Остановлено корректно');
    await step('логи', () => require('./logger').getLogger().close());

    process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown('получен SIGTERM (docker stop / перезапуск)'));
process.on('SIGINT', () => shutdown('получен SIGINT (Ctrl+C)'));

// Необработанный отказ промиса — ошибка в коде, но не повод ронять бота
// для всех студентов: записываем в лог и работаем дальше
process.on('unhandledRejection', (reason) => {
    console.error('[APP] Необработанная ошибка в асинхронном коде:', reason instanceof Error ? reason : String(reason));
});

// Необработанное исключение оставляет процесс в неизвестном состоянии —
// записываем и перезапускаемся (docker compose поднимет бота: restart: unless-stopped)
process.on('uncaughtException', (err) => {
    console.error('[APP] Критическая ошибка, бот будет перезапущен:', err);
    shutdown('критическая ошибка', 1);
});

// 11. ЗАПУСК
start();