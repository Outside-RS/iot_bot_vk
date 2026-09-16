const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { db } = require('../database');
const { VK } = require('vk-io');
const createBotInstance = require('../bot');
const { parseCommunityName, describeCommunity } = require('../courses');
const fs = require('fs');
const path = require('path');

// Состояние резервных копий для главной страницы. Файл пишет контейнер backup
// после каждой копии (см. backup/backup.sh). Копии старше двух суток
// подсвечиваются красным: иначе о том, что они перестали делаться, никто не узнает.
function readBackupStatus() {
    try {
        const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
        const st = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
        const ageHours = (Date.now() - new Date(st.time.replace(' ', 'T')).getTime()) / 3600000;
        return { ...st, stale: !(ageHours < 48) };
    } catch (e) {
        return null;   // копии не настроены или ещё ни разу не делались
    }
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Слишком много попыток входа. Повторите через 15 минут.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Журнал действий в админке: каждый изменяющий запрос с результатом и временем.
// Одно место вместо логов в каждом маршруте. GET не пишем — страница логов
// сама опрашивает сервер раз в секунду и заспамила бы журнал.
router.use((req, res, next) => {
    if (req.method === 'GET' || req.path === '/login') return next();
    const started = Date.now();
    res.on('finish', () => {
        const who = req.session && req.session.isAdmin ? 'администратор' : 'без входа';
        const line = `[ADMIN] ${req.method} ${req.originalUrl} → ${res.statusCode} за ${Date.now() - started} мс (${who}, IP ${req.ip})`;
        if (res.statusCode >= 500) console.error(line);
        else if (res.statusCode >= 400) console.warn(line);
        else console.info(line);
    });
    next();
});

// Проверка авторизации
function requireAuth(req, res, next) {
    if (req.session.isAdmin) {
        next();
    } else {
        res.redirect('/login');
    }
}

// Запрет кэширования (чтобы кнопка Назад работала нормально)
function noCache(req, res, next) {
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.header('Expires', '-1');
    res.header('Pragma', 'no-cache');
    next();
}

// === ВХОД ===
router.get('/login', (req, res) => {
    res.render('login', { error: null });
});

// Сравнение за постоянное время: хэшируем оба значения, чтобы уравнять длину
function passwordMatches(given, expected) {
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

router.post('/login', loginLimiter, (req, res) => {
    const password = req.body ? req.body.password : undefined;
    const expected = process.env.ADMIN_PASS;

    // Явные проверки типов: без них запрос без поля password при незаданном
    // ADMIN_PASS давал undefined === undefined и пускал в панель.
    if (!expected || typeof password !== 'string' || password.length === 0) {
        console.warn(`[SECURITY] Неудачная попытка входа с IP ${req.ip}`);
        return res.status(401).render('login', { error: 'Неверный пароль' });
    }

    if (!passwordMatches(password, expected)) {
        console.warn(`[SECURITY] Неверный пароль при входе с IP ${req.ip}`);
        return res.status(401).render('login', { error: 'Неверный пароль' });
    }

    // Новая сессия после входа — защита от фиксации сессии
    req.session.regenerate(err => {
        if (err) {
            console.error('[Admin] Ошибка создания сессии:', err.message);
            return res.status(500).render('login', { error: 'Ошибка сервера, попробуйте ещё раз' });
        }
        req.session.isAdmin = true;
        req.session.save(() => res.redirect('/'));
    });
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// === ДАШБОРД ===
router.get('/', requireAuth, noCache, async (req, res) => {
    try {
        const ticketCount = await db.query('SELECT count(*) FROM tickets');
        const botsCount = Object.keys(global.bots || {}).length;

        // Тестовый код доступа из миграции: пока он в базе, роль администратора
        // может получить любой, кто введёт его в боте. Предупреждаем явно.
        let testCodeActive = false;
        try {
            const testCode = await db.query("SELECT code FROM operator_codes WHERE code = 'ADMIN-MAIN'");
            testCodeActive = testCode.rows.length > 0;
        } catch (e) { /* таблицы может не быть до миграции */ }

        // Получаем настройки ИИ из БД
        let aiSettings = { ollama_url: 'http://127.0.0.1:11434', ollama_model: 'qwen2.5:7b', gigachat_model: 'GigaChat-2' };
        try {
            const settingsRes = await db.query('SELECT * FROM app_settings WHERE id = TRUE');
            if (settingsRes.rows.length > 0) aiSettings = settingsRes.rows[0];
        } catch (e) { /* таблица может не существовать */ }

        // Проверка Ollama
        let ollamaStatus = 'offline';
        try {
            const ollamaRes = await fetch((aiSettings.ollama_url || 'http://127.0.0.1:11434') + '/api/tags', {
                signal: AbortSignal.timeout(2000)
            });
            if (ollamaRes.ok) ollamaStatus = 'online';
        } catch (e) { /* Ollama не отвечает */ }

        // Проверка GigaChat
        let gigachatStatus = 'offline';
        if (aiSettings.gigachat_key) {
            try {
                const { gigaChatFetch } = require('../ai_service');
                const crypto = require('crypto');
                const tokenRes = await gigaChatFetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json',
                        'Authorization': `Basic ${aiSettings.gigachat_key}`,
                        'RqUID': crypto.randomUUID()
                    },
                    body: `scope=${aiSettings.gigachat_scope || 'GIGACHAT_API_PERS'}`
                });
                if (tokenRes.ok) gigachatStatus = 'online';
            } catch (e) { /* GigaChat недоступен */ }
        }

        res.render('dashboard', {
            count: ticketCount.rows[0].count,
            botsCount,
            testCodeActive,
            ollamaStatus,
            ollamaModel: aiSettings.ollama_model || 'qwen2.5:7b',
            gigachatStatus,
            gigachatModel: aiSettings.gigachat_model || 'GigaChat-2',
            backup: readBackupStatus()
        });
    } catch (e) {
        console.error('[Admin] Dashboard error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// Расход токенов в формате для дашборда
async function readUsage() {
    const u = await db.query('SELECT model_class, model_id, tokens_used, quota, exhausted FROM ai_usage ORDER BY quota DESC');
    return u.rows.map(r => ({
        modelClass: r.model_class,
        modelId: r.model_id,
        used: Number(r.tokens_used),
        quota: Number(r.quota),
        exhausted: r.exhausted,
        percent: r.quota > 0 ? Math.round((Number(r.tokens_used) / Number(r.quota)) * 100) : 0
    }));
}

// === API: Сверить остаток токенов с личным кабинетом Сбера (кнопка ↻) ===
router.post('/api/ai-balance/refresh', requireAuth, async (req, res) => {
    try {
        const { syncBalanceFromGigaChat } = require('../ai_service');
        await syncBalanceFromGigaChat();
        res.json({ usage: await readUsage(), syncedAt: new Date().toISOString() });
    } catch (e) {
        console.error('[Admin] Не удалось получить баланс GigaChat:', e.message);
        res.status(502).json({ error: e.message });
    }
});

// === API: Статус ИИ (AJAX) ===
router.get('/api/ai-status', requireAuth, async (req, res) => {
    try {
        // Настройки из БД
        let settings = { ollama_url: 'http://127.0.0.1:11434', ollama_model: 'qwen2.5:7b', gigachat_key: null, gigachat_scope: 'GIGACHAT_API_PERS', gigachat_model: 'GigaChat-2' };
        try {
            const r = await db.query('SELECT * FROM app_settings WHERE id = TRUE');
            if (r.rows.length > 0) settings = r.rows[0];
        } catch (e) { }

        // Статус Ollama + список моделей
        let ollamaStatus = 'offline';
        let ollamaModels = [];
        try {
            const ollamaRes = await fetch((settings.ollama_url || 'http://127.0.0.1:11434') + '/api/tags', {
                signal: AbortSignal.timeout(3000)
            });
            if (ollamaRes.ok) {
                ollamaStatus = 'online';
                const data = await ollamaRes.json();
                ollamaModels = (data.models || []).map(m => m.name);
            }
        } catch (e) { }

        // Расход токенов по классам моделей (у каждого своя независимая квота)
        let usage = [];
        try {
            usage = await readUsage();
        } catch (e) { /* таблицы нет до запуска migrate_update.js */ }

        // Статус GigaChat
        let gigachatStatus = settings.gigachat_key ? 'configured' : 'no_key';

        // Маскируем ключ для безопасности: показываем только последние 6 символов
        let maskedKey = '';
        if (settings.gigachat_key) {
            const key = settings.gigachat_key;
            maskedKey = key.length > 6 ? '***' + key.slice(-6) : '***';
        }

        res.json({
            ollama: {
                status: ollamaStatus,
                url: settings.ollama_url || 'http://127.0.0.1:11434',
                model: settings.ollama_model || 'qwen2.5:7b',
                models: ollamaModels
            },
            gigachat: {
                status: gigachatStatus,
                model: settings.gigachat_model || 'GigaChat-2',
                scope: settings.gigachat_scope || 'GIGACHAT_API_PERS',
                maskedKey,
                usage
            }
        });
    } catch (e) {
        console.error('[Admin] AI status error:', e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
});

// === API: Сохранение настроек ИИ ===
router.post('/ai-settings', requireAuth, async (req, res) => {
    try {
        const { ollama_url, ollama_model, gigachat_key, gigachat_scope, gigachat_model } = req.body;

        // Получаем текущий ключ чтобы понять, изменился ли он
        const current = await db.query('SELECT gigachat_key FROM app_settings WHERE id = TRUE');
        const oldKey = current.rows.length > 0 ? current.rows[0].gigachat_key : null;

        // Обновляем настройки в БД
        await db.query(`
            INSERT INTO app_settings (id, ollama_url, ollama_model, gigachat_key, gigachat_scope, gigachat_model)
            VALUES (TRUE, $1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET
                ollama_url = $1,
                ollama_model = $2,
                gigachat_key = COALESCE(NULLIF($3, ''), app_settings.gigachat_key),
                gigachat_scope = $4,
                gigachat_model = $5
        `, [
            ollama_url || 'http://127.0.0.1:11434',
            ollama_model || 'qwen2.5:7b',
            gigachat_key || '',
            gigachat_scope || 'GIGACHAT_API_PERS',
            gigachat_model || 'GigaChat-2'
        ]);

        // Сбрасываем кэши в AI Service
        const { invalidateSettingsCache, resetGigaChatToken } = require('../ai_service');
        invalidateSettingsCache();

        // Если ключ GigaChat изменился — сбросить токен
        if (gigachat_key && gigachat_key !== '' && gigachat_key !== oldKey) {
            resetGigaChatToken();
            console.log('[Admin] GigaChat ключ изменён, токен сброшен');
        }

        console.log(`[Admin] Настройки ИИ обновлены: Ollama=${ollama_model}, GigaChat=${gigachat_model}`);
        res.json({ success: true, message: 'Настройки сохранены' });
    } catch (e) {
        console.error('[Admin] Ошибка сохранения настроек:', e.message);
        res.status(500).json({ error: 'Не удалось сохранить настройки.' });
    }
});

// === API: Удаление ключа GigaChat ===
router.delete('/ai-settings/gigachat-key', requireAuth, async (req, res) => {
    try {
        await db.query('UPDATE app_settings SET gigachat_key = NULL WHERE id = TRUE');
        const { invalidateSettingsCache, resetGigaChatToken } = require('../ai_service');
        invalidateSettingsCache();
        resetGigaChatToken();
        console.log('[Admin] GigaChat ключ удалён');
        res.json({ success: true, message: 'Ключ удалён' });
    } catch (e) {
        console.error('[Admin] Ошибка удаления ключа:', e.message);
        res.status(500).json({ error: 'Не удалось удалить ключ.' });
    }
});

// === БАЗА ЗНАНИЙ (FAQ) ===

// 1. Просмотр списка
router.get('/faq', requireAuth, noCache, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM faq ORDER BY category ASC, id DESC');
        const cats = await db.query("SELECT DISTINCT category FROM faq WHERE category IS NOT NULL AND category <> '' ORDER BY category");
        res.render('faq', {
            faq: result.rows,
            categories: cats.rows.map(r => r.category),
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error('[Admin] Error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// 2. Импорт FAQ из JSON в БД (upsert по вопросу)
router.post('/faq/import-json', requireAuth, async (req, res) => {
    const data = req.body;
    if (!Array.isArray(data)) {
        return res.status(400).json({ error: 'Ожидается массив объектов JSON.' });
    }

    let added = 0, updated = 0, skipped = 0;

    for (const item of data) {
        if (!item.question || !item.answer) { skipped++; continue; }

        const keywords = (Array.isArray(item.keywords) ? item.keywords : (item.keywords || '').split(','))
            .map(k => k.trim())
            .filter(k => k.length > 0)
            .join(', ');

        try {
            const existing = await db.query('SELECT id, answer, keywords FROM faq WHERE question = $1', [item.question]);

            if (existing.rows.length > 0) {
                const row = existing.rows[0];
                if (row.answer !== item.answer || row.keywords !== keywords) {
                    await db.query(
                        'UPDATE faq SET category = $1, answer = $2, keywords = $3 WHERE id = $4',
                        [item.category || '', item.answer, keywords, row.id]
                    );
                    updated++;
                }
            } else {
                await db.query(
                    'INSERT INTO faq (category, question, answer, keywords) VALUES ($1, $2, $3, $4)',
                    [item.category || '', item.question, item.answer, keywords]
                );
                added++;
            }
        } catch (e) {
            console.error('[Admin] FAQ import item error:', e.message);
            skipped++;
        }
    }

    console.log(`[Admin] FAQ import: добавлено ${added}, обновлено ${updated}, пропущено ${skipped}`);
    res.json({ success: true, added, updated, skipped });
});

// 3. Экспорт FAQ из БД в faq_data.json
router.post('/faq/export-json', requireAuth, async (_req, res) => {
    try {
        const result = await db.query('SELECT category, question, answer, keywords FROM faq ORDER BY category ASC, id ASC');
        const data = result.rows.map(row => ({
            category: row.category || '',
            question: row.question,
            answer: row.answer,
            keywords: row.keywords ? row.keywords.split(',').map(k => k.trim()).filter(k => k.length > 0) : []
        }));
        const fs = require('fs');
        const path = require('path');
        const filePath = path.join(__dirname, '..', 'faq_data.json');
        fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
        console.log(`[Admin] faq_data.json обновлён: ${data.length} записей`);
        res.redirect('/faq?success=' + encodeURIComponent(`✅ faq_data.json обновлён (${data.length} вопросов)`));
    } catch (e) {
        console.error('[Admin] FAQ export error:', e.message);
        res.redirect('/faq?error=' + encodeURIComponent('Ошибка при экспорте в файл.'));
    }
});

// 2b. Скачать базу знаний как JSON-файл прямо в браузер
router.get('/faq/download-json', requireAuth, async (_req, res) => {
    try {
        const result = await db.query('SELECT category, question, answer, keywords FROM faq ORDER BY category ASC, id ASC');
        const data = result.rows.map(row => ({
            category: row.category || '',
            question: row.question,
            answer: row.answer,
            keywords: row.keywords ? row.keywords.split(',').map(k => k.trim()).filter(k => k.length > 0) : []
        }));
        const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const filename = `faq_backup_${date}.json`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(JSON.stringify(data, null, 4));
        console.log(`[Admin] Скачана база знаний: ${data.length} записей`);
    } catch (e) {
        console.error('[Admin] FAQ download error:', e.message);
        res.status(500).send('Ошибка при скачивании базы.');
    }
});


router.post('/faq/add', requireAuth, noCache, async (req, res) => {
    const { category, question, answer, keywords } = req.body;

    try {
        const normalizedKeywords = (keywords || '')
            .split(',')
            .map(k => k.trim())
            .filter(k => k.length > 0)
            .join(', ');

        // 2. Сохраняем в базу (tsvector генерируется сам)
        await db.query(
            `INSERT INTO faq (category, question, answer, keywords) VALUES ($1, $2, $3, $4)`,
            [category, question, answer, normalizedKeywords]
        );

        // 3. Редирект с успехом (PRG паттерн)
        res.redirect('/faq?success=' + encodeURIComponent('✅ Вопрос успешно добавлен!'));

    } catch (e) {
        console.error('[Admin] FAQ add error:', e.message);
        res.redirect('/faq?error=' + encodeURIComponent('Ошибка при сохранении вопроса.'));
    }
});

// 3. Удаление вопроса
router.post('/faq/delete/:id', requireAuth, noCache, async (req, res) => {
    try {
        await db.query('DELETE FROM faq WHERE id = $1', [req.params.id]);
        res.redirect('/faq');
    } catch (e) {
        console.error('[Admin] Delete error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// === РЕДАКТИРОВАНИЕ FAQ ===

// 1. Открыть страницу редактирования
router.get('/faq/edit/:id', requireAuth, noCache, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM faq WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.send('Вопрос не найден');
        }
        const cats = await db.query("SELECT DISTINCT category FROM faq WHERE category IS NOT NULL AND category <> '' ORDER BY category");
        res.render('edit_faq', { item: result.rows[0], categories: cats.rows.map(r => r.category) });
    } catch (e) {
        console.error('[Admin] Error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// 2. Сохранить изменения
router.post('/faq/edit/:id', requireAuth, noCache, async (req, res) => {
    const { category, question, answer, keywords } = req.body;
    const id = req.params.id;

    try {
        const normalizedKeywords = (keywords || '')
            .split(',')
            .map(k => k.trim())
            .filter(k => k.length > 0)
            .join(', ');

        await db.query(
            `UPDATE faq 
             SET category = $1, question = $2, answer = $3, keywords = $4
             WHERE id = $5`,
            [category, question, answer, normalizedKeywords, id]
        );

        res.redirect('/faq'); // Возвращаемся к списку
    } catch (e) {
        console.error('[Admin] Update error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// === АДМИНИСТРАТОРЫ ===

// Страница редактирования администратора
router.get('/tutors/edit/:code', requireAuth, noCache, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM operator_codes WHERE code = $1', [req.params.code]);
        if (result.rows.length === 0) return res.send('Код не найден');
        res.render('edit_tutor', { tutor: result.rows[0] });
    } catch (e) {
        console.error('[Admin] Error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// Сохранение администратора
router.post('/tutors/edit/:code', requireAuth, async (req, res) => {
    const { name } = req.body;
    try {
        await db.query(
            'UPDATE operator_codes SET admin_name = $1 WHERE code = $2',
            [name, req.params.code]
        );
        res.redirect('/tutors');
    } catch (e) {
        console.error('[Admin] Update error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

router.get('/tutors', requireAuth, noCache, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM operator_codes ORDER BY code ASC');
        res.render('tutors', { tutors: result.rows });
    } catch (e) {
        console.error('[Admin] Error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

router.post('/tutors/add', requireAuth, noCache, async (req, res) => {
    const { name, code } = req.body;
    try {
        await db.query(
            'INSERT INTO operator_codes (code, admin_name) VALUES ($1, $2)',
            [code, name]
        );
        res.redirect('/tutors');
    } catch (e) {
        console.error('[Admin] Tutor add error:', e.message);
        res.status(500).send('Ошибка: возможно, такой код уже существует.');
    }
});

router.post('/tutors/delete/:code', requireAuth, noCache, async (req, res) => {
    try {
        await db.query('DELETE FROM operator_codes WHERE code = $1', [req.params.code]);
        res.redirect('/tutors');
    } catch (e) {
        console.error('[Admin] Delete error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// === РАССЫЛКА ===

router.get('/broadcast', requireAuth, noCache, async (req, res) => {
    try {
        const groups = await db.query('SELECT group_id, group_name FROM vk_groups WHERE is_active = TRUE');
        res.render('broadcast', { groups: groups.rows });
    } catch (e) {
        res.render('broadcast', { groups: [] });
    }
});

router.post('/broadcast/send', requireAuth, async (req, res) => {
    const { message, target, group_number, vk_group_id } = req.body;

    // Получаем бота для отправки
    const botGroupId = vk_group_id || Object.keys(global.bots)[0];
    const bot = global.bots[botGroupId];

    if (!bot) {
        return res.send('<h1>❌ Нет активных ботов!</h1><a href="/groups">Добавить группу</a>');
    }

    (async () => {
        try {
            let query = '';
            let params = [];

            if (target === 'all') {
                query = 'SELECT vk_id FROM users';
            } else if (target === 'students') {
                query = "SELECT vk_id FROM users WHERE role = 'student'";
            } else if (target === 'tutors') {
                query = "SELECT vk_id FROM users WHERE role = 'operator'";
            } else if (target === 'group' && group_number && group_number.trim()) {
                query = "SELECT vk_id FROM users WHERE group_number = $1";
                params = [group_number.trim().toUpperCase()];
            } else {
                // Раньше неизвестная цель или пустой номер группы давали пустой
                // SQL-запрос или TypeError — рассылка молча не происходила
                console.warn(`[ADMIN] Рассылка не запущена: некорректная цель «${target}»${target === 'group' ? ' (не указан номер группы)' : ''}`);
                return;
            }

            const users = await db.query(query, params);
            console.info(`[ADMIN] Рассылка запущена через группу ${botGroupId}: цель «${target}${params.length ? ' ' + params[0] : ''}», получателей ${users.rows.length}`);

            // Раньше ошибки отправки глотались пустым catch — считаем и
            // показываем причины, чтобы было понятно, почему не всем дошло
            let delivered = 0;
            const failures = {};
            for (const user of users.rows) {
                try {
                    await bot.api.messages.send({
                        peer_id: user.vk_id,
                        message: `📢 РАССЫЛКА:\n\n${message}`,
                        random_id: 0
                    });
                    delivered++;
                } catch (err) {
                    const reason = err.code ? `код ${err.code}` : err.message;
                    failures[reason] = (failures[reason] || 0) + 1;
                    console.debug(`[VK] Рассылка: не доставлено ${user.vk_id}:`, err);
                }
                await new Promise(r => setTimeout(r, 50));
            }

            const failed = users.rows.length - delivered;
            const reasons = Object.entries(failures).map(([r, n]) => `${r} — ${n}`).join('; ');
            const summary = `[ADMIN] Рассылка завершена: доставлено ${delivered} из ${users.rows.length}${failed ? `, не доставлено ${failed} (${reasons})` : ''}`;
            if (failed) console.warn(summary); else console.info(summary);
        } catch (e) {
            console.error('[ADMIN] Рассылка прервана ошибкой:', e);
        }
    })();

    res.redirect('/');
});

// === ГРУППЫ VK ===

// Список групп
router.get('/groups', requireAuth, noCache, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM vk_groups ORDER BY created_at DESC');
        res.render('groups', { groups: result.rows, error: null, success: null });
    } catch (e) {
        console.error('[Admin] Error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// Итог сверки одного сообщества — человеческим языком для плашки на странице
function describeSyncResult(r) {
    if (r.error) return `«${r.oldName}»: не удалось сверить — ${r.error}`;
    const renamed = r.newName !== r.oldName ? `«${r.oldName}» → «${r.newName}»` : `«${r.newName}»`;
    switch (r.action) {
        case 'promote': return `${renamed}: курс ${r.before.course} → ${r.after.course}, переведено студентов: ${r.changed}`;
        case 'graduate': return `${renamed}: ушло в архив, выпущено студентов: ${r.changed}`;
        case 'anomaly': return `${renamed}: необычная смена курса ${r.before.course} → ${r.after.course} — похоже на опечатку. Студенты не переведены, в боте оставлен ${r.before.course} курс. Исправьте название в VK и нажмите ↻`;
        case 'reopen': return `${renamed}: сообщество вернулось из архива, теперь ${describeCommunity(r.after)}`;
        default: return `${renamed}: ${describeCommunity(r.after)}${r.newName !== r.oldName ? ', название обновлено' : ', без изменений'}`;
    }
}

async function renderGroups(res, { error = null, success = null } = {}) {
    const result = await db.query('SELECT * FROM vk_groups ORDER BY created_at DESC');
    res.render('groups', { groups: result.rows, error, success });
}

// Сверить одно сообщество с VK (кнопка ↻ в строке)
router.post('/groups/sync/:id', requireAuth, noCache, async (req, res) => {
    try {
        const g = await db.query('SELECT * FROM vk_groups WHERE id = $1', [req.params.id]);
        if (g.rows.length === 0) return renderGroups(res, { error: 'Сообщество не найдено.' });
        const { syncGroup } = require('../group_sync');
        const r = await syncGroup(g.rows[0]);
        const text = describeSyncResult(r);
        await renderGroups(res, r.action === 'anomaly' ? { error: text } : { success: text });
    } catch (e) {
        console.error('[GROUPS] Ручная сверка не удалась:', e);
        await renderGroups(res, { error: `Не удалось сверить с VK: ${e.message}` }).catch(() => res.status(500).send('Внутренняя ошибка сервера.'));
    }
});

// Сверить все сообщества разом
router.post('/groups/sync-all', requireAuth, noCache, async (req, res) => {
    try {
        const { syncAllGroups } = require('../group_sync');
        const results = await syncAllGroups('вручную из админки');
        const problems = results.filter(r => r.error || r.action === 'anomaly');
        const text = results.map(describeSyncResult).join(' · ');
        await renderGroups(res, problems.length ? { error: text } : { success: text || 'Сообществ нет.' });
    } catch (e) {
        console.error('[GROUPS] Ручная сверка всех сообществ не удалась:', e);
        await renderGroups(res, { error: `Не удалось сверить с VK: ${e.message}` }).catch(() => res.status(500).send('Внутренняя ошибка сервера.'));
    }
});

// Добавить группу
router.post('/groups/add', requireAuth, noCache, async (req, res) => {
    let { group_id, access_token, group_name } = req.body;

    try {
        group_id = String(group_id || '').trim();
        access_token = String(access_token || '').trim();
        if (!/^\d+$/.test(group_id)) {
            return renderGroups(res, { error: '❌ ID группы — это число, например 234189923 (без минуса и букв).' });
        }

        // Проверка токена через VK API. Раньше токен подставлялся прямо в адрес
        // запроса (…&access_token=…) — такие адреса оседают в логах прокси и
        // серверов. vk-io передаёт его в теле запроса.
        let vkName = null;
        try {
            const vkRes = await new VK({ token: access_token }).api.groups.getById({ group_id });
            // В разных версиях API ответ — массив или объект { groups: [...] }
            const list = Array.isArray(vkRes) ? vkRes : ((vkRes && vkRes.groups) || []);
            vkName = list[0] ? list[0].name : null;
        } catch (vkErr) {
            console.warn(`[ADMIN] Токен группы ${group_id} не принят VK:`, vkErr);
            return renderGroups(res, { error: `❌ Ошибка VK API: ${vkErr.message}` });
        }
        if (!group_name && vkName) {
            group_name = vkName;
        } else if (!group_name) {
            group_name = `Группа ${group_id}`;
        }

        // Курс — из настоящего названия в VK, даже если в форме ввели своё:
        // по нему потом проверяется номер группы при регистрации и переводится курс
        const community = parseCommunityName(vkName || group_name);
        await db.query(
            `INSERT INTO vk_groups (group_id, group_name, access_token, course, is_archived, name_synced_at)
             VALUES ($1, $2, $3, $4, $5, ${vkName ? 'NOW()' : 'NULL'})`,
            [group_id, group_name, access_token, community.course, community.archived]
        );
        console.info(`[GROUPS] Добавлено сообщество «${group_name}» (ID ${group_id}): ${describeCommunity(community)}`);

        // Динамически запускаем бота сразу (без перезапуска сервера)
        let startError = null;
        try {
            const botInstance = createBotInstance(access_token, group_id, group_name);
            await botInstance.updates.start();
            global.bots[group_id] = botInstance;
            console.log(`[ADMIN] Бот динамически запущен: ${group_name}`);
        } catch (botErr) {
            startError = botErr.message;
            console.error(`[ADMIN] Не удалось запустить бота ${group_name}: ${botErr.message}`);
        }

        // Сообщение отражает реальный результат: группа могла сохраниться,
        // но бот не стартовать (неверный токен, выключен Long Poll, ограничение списка групп)
        const result = await db.query('SELECT * FROM vk_groups ORDER BY created_at DESC');
        res.render('groups', {
            groups: result.rows,
            error: startError ? `⚠️ Группа "${group_name}" сохранена, но бот не запущен: ${startError}` : null,
            success: startError ? null : `✅ Группа "${group_name}" добавлена и запущена!`
        });
    } catch (e) {
        console.error('[Admin] Error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// Удалить группу
router.post('/groups/delete/:id', requireAuth, noCache, async (req, res) => {
    try {
        // Получаем group_id перед удалением
        const groupRes = await db.query('SELECT group_id, group_name FROM vk_groups WHERE id = $1', [req.params.id]);
        if (groupRes.rows.length > 0) {
            const groupId = groupRes.rows[0].group_id;
            // Останавливаем бота если он запущен
            if (global.bots[groupId]) {
                await global.bots[groupId].updates.stop();
                delete global.bots[groupId];
                console.log(`[ADMIN] Бот остановлен: ${groupRes.rows[0].group_name}`);
            }
        }
        await db.query('DELETE FROM vk_groups WHERE id = $1', [req.params.id]);
        res.redirect('/groups');
    } catch (e) {
        console.error('[Admin] Delete error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// Вкл/Выкл группу
router.post('/groups/toggle/:id', requireAuth, noCache, async (req, res) => {
    try {
        // Получаем текущее состояние
        const groupRes = await db.query('SELECT group_id, group_name, access_token, is_active FROM vk_groups WHERE id = $1', [req.params.id]);
        if (groupRes.rows.length > 0) {
            const group = groupRes.rows[0];
            if (group.is_active) {
                // Выключаем — останавливаем бота
                if (global.bots[group.group_id]) {
                    await global.bots[group.group_id].updates.stop();
                    delete global.bots[group.group_id];
                    console.log(`[ADMIN] Бот отключен: ${group.group_name}`);
                }
            } else {
                // Включаем — запускаем бота
                try {
                    const botInstance = createBotInstance(group.access_token, group.group_id, group.group_name);
                    await botInstance.updates.start();
                    global.bots[group.group_id] = botInstance;
                    console.log(`[ADMIN] Бот включен: ${group.group_name}`);
                } catch (botErr) {
                    console.error(`[ADMIN] Ошибка запуска: ${botErr.message}`);
                }
            }
        }
        await db.query('UPDATE vk_groups SET is_active = NOT is_active WHERE id = $1', [req.params.id]);
        res.redirect('/groups');
    } catch (e) {
        console.error('[Admin] Error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// === ПОЛЬЗОВАТЕЛИ ===

// Функция увеличения курса в номере группы (РИ-140944 -> РИ-240944)
function promoteCourse(groupNumber) {
    if (!groupNumber) return groupNumber;
    // Ищем паттерн: буквы-цифры, первая цифра — курс
    return groupNumber.replace(/^([А-Яа-яA-Za-z]+-?)(\d)/, (match, prefix, courseDigit) => {
        const newCourse = Math.min(parseInt(courseDigit) + 1, 9);
        return prefix + newCourse;
    });
}

// Список пользователей с фильтрами
router.get('/users', requireAuth, noCache, async (req, res) => {
    try {
        const { course, group, role, graduated } = req.query;

        let query = 'SELECT * FROM users WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        // Фильтр по курсу (первая цифра после дефиса)
        // Курс — одна цифра. Раньше значение без проверки уходило в регулярное
        // выражение PostgreSQL (оператор ~), и строка вроде (a+)+$ могла подвесить базу
        if (/^[1-9]$/.test(course || '')) {
            query += ` AND group_number ~ $${paramIndex}`;
            params.push(`^[А-Яа-яA-Za-z]+-${course}`);
            paramIndex++;
        }

        // Фильтр по группе
        if (group) {
            query += ` AND group_number ILIKE $${paramIndex}`;
            params.push(`%${group}%`);
            paramIndex++;
        }

        // Фильтр по роли
        if (role) {
            query += ` AND role = $${paramIndex}`;
            params.push(role);
            paramIndex++;
        }

        // Фильтр по статусу выпускника
        if (graduated === 'true') {
            query += ' AND is_graduated = TRUE';
        } else if (graduated === 'false') {
            query += ' AND (is_graduated = FALSE OR is_graduated IS NULL)';
        }

        query += ' ORDER BY created_at DESC';

        const result = await db.query(query, params);

        res.render('users', {
            users: result.rows,
            filter_course: course || '',
            filter_group: group || '',
            filter_role: role || '',
            filter_graduated: graduated || '',
            success: req.query.success,
            error: req.query.error
        });
    } catch (e) {
        console.error('[Admin] Error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

// Перевести на +1 курс (одного)
router.post('/users/promote/:vk_id', requireAuth, noCache, async (req, res) => {
    try {
        const { vk_id } = req.params;
        const user = await db.query('SELECT group_number, study_years FROM users WHERE vk_id = $1', [vk_id]);

        if (user.rows.length > 0) {
            const newGroup = promoteCourse(user.rows[0].group_number);

            // Проверяем, не выпускник ли
            const courseMatch = newGroup ? newGroup.match(/-(\d)/) : null;
            const newCourse = courseMatch ? parseInt(courseMatch[1]) : 1;
            const studyYears = user.rows[0].study_years || 4;

            if (newCourse > studyYears) {
                // Помечаем как выпускника
                await db.query('UPDATE users SET group_number = $1, is_graduated = TRUE WHERE vk_id = $2', [newGroup, vk_id]);
            } else {
                await db.query('UPDATE users SET group_number = $1 WHERE vk_id = $2', [newGroup, vk_id]);
            }
        }

        res.redirect('/users?success=' + encodeURIComponent('Курс обновлён'));
    } catch (e) {
        console.error('[Admin] Users error:', e.message);
        res.redirect('/users?error=' + encodeURIComponent('Внутренняя ошибка сервера.'));
    }
});

// Пометить выпускником
router.post('/users/graduate/:vk_id', requireAuth, noCache, async (req, res) => {
    try {
        await db.query('UPDATE users SET is_graduated = TRUE WHERE vk_id = $1', [req.params.vk_id]);
        res.redirect('/users?success=' + encodeURIComponent('Пользователь помечен как выпускник'));
    } catch (e) {
        console.error('[Admin] Users error:', e.message);
        res.redirect('/users?error=' + encodeURIComponent('Внутренняя ошибка сервера.'));
    }
});

// Удалить пользователя
router.post('/users/delete/:vk_id', requireAuth, noCache, async (req, res) => {
    try {
        await db.query('DELETE FROM users WHERE vk_id = $1', [req.params.vk_id]);
        res.redirect('/users?success=' + encodeURIComponent('Пользователь удалён'));
    } catch (e) {
        console.error('[Admin] Users error:', e.message);
        res.redirect('/users?error=' + encodeURIComponent('Внутренняя ошибка сервера.'));
    }
});

// Перевести всех отфильтрованных на +1 курс
router.post('/users/promote-all', requireAuth, noCache, async (req, res) => {
    try {
        const { course, group, role } = req.body;

        let query = 'SELECT vk_id, group_number, study_years FROM users WHERE (is_graduated = FALSE OR is_graduated IS NULL)';
        const params = [];
        let paramIndex = 1;

        // Курс — одна цифра. Раньше значение без проверки уходило в регулярное
        // выражение PostgreSQL (оператор ~), и строка вроде (a+)+$ могла подвесить базу
        if (/^[1-9]$/.test(course || '')) {
            query += ` AND group_number ~ $${paramIndex}`;
            params.push(`^[А-Яа-яA-Za-z]+-${course}`);
            paramIndex++;
        }

        if (group) {
            query += ` AND group_number ILIKE $${paramIndex}`;
            params.push(`%${group}%`);
            paramIndex++;
        }

        if (role) {
            query += ` AND role = $${paramIndex}`;
            params.push(role);
            paramIndex++;
        }

        const result = await db.query(query, params);
        let promoted = 0;
        let graduated = 0;

        for (const user of result.rows) {
            const newGroup = promoteCourse(user.group_number);
            const courseMatch = newGroup ? newGroup.match(/-(\d)/) : null;
            const newCourse = courseMatch ? parseInt(courseMatch[1]) : 1;
            const studyYears = user.study_years || 4;

            if (newCourse > studyYears) {
                await db.query('UPDATE users SET group_number = $1, is_graduated = TRUE WHERE vk_id = $2', [newGroup, user.vk_id]);
                graduated++;
            } else {
                await db.query('UPDATE users SET group_number = $1 WHERE vk_id = $2', [newGroup, user.vk_id]);
                promoted++;
            }
        }

        // Обновление групп у администраторов больше не требуется (нет привязки к группам)

        res.redirect('/users?success=' + encodeURIComponent(`✅ Переведено: ${promoted}, Выпущено: ${graduated}`));
    } catch (e) {
        console.error('[Admin] Users error:', e.message);
        res.redirect('/users?error=' + encodeURIComponent('Внутренняя ошибка сервера.'));
    }
});
// ====== ОТЗЫВЫ И ЖАЛОБЫ ======

// 1. Страница списка отзывов
router.get('/feedback', requireAuth, noCache, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT f.id, f.vk_id, f.text, f.status, f.created_at, u.full_name, u.role
            FROM feedback f
            JOIN users u ON f.vk_id = u.vk_id
            ORDER BY f.created_at DESC
        `);
        res.render('feedback', { feedbackList: result.rows, currentRoute: '/feedback' });
    } catch (err) {
        console.error('[ADMIN] Ошибка в разделе отзывов:', err);
        res.status(500).send('Ошибка при загрузке отзывов.');
    }
});

// 2. Смена статуса
router.post('/feedback/status/:id', requireAuth, async (req, res) => {
    const id = req.params.id;
    const { status } = req.body;
    try {
        await db.query('UPDATE feedback SET status = $1 WHERE id = $2', [status, id]);
        res.redirect('/feedback');
    } catch (err) {
        console.error('[ADMIN] Ошибка в разделе отзывов:', err);
        res.status(500).send('Ошибка изменения статуса.');
    }
});

// 3. Удаление
router.post('/feedback/delete/:id', requireAuth, async (req, res) => {
    const id = req.params.id;
    try {
        await db.query('DELETE FROM feedback WHERE id = $1', [id]);
        res.redirect('/feedback');
    } catch (err) {
        console.error('[ADMIN] Ошибка в разделе отзывов:', err);
        res.status(500).send('Ошибка удаления.');
    }
});
// ====== ЛОГИ (Терминал) ======

router.get('/logs', requireAuth, noCache, (req, res) => {
    const logger = require('../logger').getLogger();
    res.render('logs', { currentRoute: '/logs', logFiles: logger ? logger.files() : [] });
});

// Записи из памяти. ?since=<id> — только новее указанной: страница опрашивает
// сервер раз в секунду и раньше каждый раз получала все 500 строк целиком.
router.get('/api/logs', requireAuth, (req, res) => {
    const logger = require('../logger').getLogger();
    const since = Number.parseInt(req.query.since, 10) || 0;
    res.json({ entries: logger ? logger.entries(since) : [] });
});

// Скачать файл лога за день — вся история, в том числе после перезапусков
router.get('/logs/download/:day', requireAuth, (req, res) => {
    const logger = require('../logger').getLogger();
    // filePath сам проверяет формат ГГГГ-ММ-ДД — через параметр не выйти за папку логов
    const file = logger && logger.filePath(req.params.day);
    if (!file) return res.status(404).send('Лог за эту дату не найден.');
    console.info(`[ADMIN] Скачан файл лога за ${req.params.day} (IP ${req.ip})`);
    res.download(file, `bot-log-${req.params.day}.log`);
});

module.exports = router;