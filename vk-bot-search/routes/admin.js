const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { db } = require('../database');
const createBotInstance = require('../bot');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Слишком много попыток входа. Повторите через 15 минут.',
    standardHeaders: true,
    legacyHeaders: false,
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

router.post('/login', loginLimiter, (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASS) {
        req.session.isAdmin = true;
        req.session.save(() => res.redirect('/'));
    } else {
        res.render('login', { error: 'Неверный пароль' });
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// === ДАШБОРД ===
router.get('/', requireAuth, noCache, async (req, res) => {
    try {
        const ticketCount = await db.query('SELECT count(*) FROM tickets');
        const botsCount = Object.keys(global.bots || {}).length;

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
            ollamaStatus,
            ollamaModel: aiSettings.ollama_model || 'qwen2.5:7b',
            gigachatStatus,
            gigachatModel: aiSettings.gigachat_model || 'GigaChat-2'
        });
    } catch (e) {
        console.error('[Admin] Dashboard error:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
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
                maskedKey
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

// 2. Добавление вопроса
router.post('/faq/add', requireAuth, noCache, async (req, res) => {
    const { category, question, answer, keywords } = req.body;

    try {
        // 2. Сохраняем в базу (tsvector генерируется сам)
        await db.query(
            `INSERT INTO faq (category, question, answer, keywords) VALUES ($1, $2, $3, $4)`,
            [category, question, answer, keywords]
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
        await db.query(
            `UPDATE faq 
             SET category = $1, question = $2, answer = $3, keywords = $4
             WHERE id = $5`,
            [category, question, answer, keywords, id]
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
            console.log(`🚀 Рассылка через группу ${botGroupId}. Цель: ${target}`);
            let query = '';
            let params = [];

            if (target === 'all') {
                query = 'SELECT vk_id FROM users';
            } else if (target === 'students') {
                query = "SELECT vk_id FROM users WHERE role = 'student'";
            } else if (target === 'tutors') {
                query = "SELECT vk_id FROM users WHERE role = 'operator'";
            } else if (target === 'group') {
                query = "SELECT vk_id FROM users WHERE group_number = $1";
                params = [group_number.trim().toUpperCase()];
            }

            const users = await db.query(query, params);
            let count = 0;

            for (const user of users.rows) {
                try {
                    await bot.api.messages.send({
                        peer_id: user.vk_id,
                        message: `📢 РАССЫЛКА:\n\n${message}`,
                        random_id: 0
                    });
                    count++;
                    await new Promise(r => setTimeout(r, 50));
                } catch (err) { }
            }
            console.log(`✅ Рассылка завершена. Доставлено: ${count}`);
        } catch (e) {
            console.error('Ошибка рассылки:', e);
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

// Добавить группу
router.post('/groups/add', requireAuth, noCache, async (req, res) => {
    let { group_id, access_token, group_name } = req.body;

    try {
        // Валидация токена через VK API
        const response = await fetch(
            `https://api.vk.com/method/groups.getById?group_id=${group_id}&access_token=${access_token}&v=5.199`
        );
        const data = await response.json();

        if (data.error) {
            const result = await db.query('SELECT * FROM vk_groups ORDER BY created_at DESC');
            return res.render('groups', {
                groups: result.rows,
                error: `❌ Ошибка VK API: ${data.error.error_msg}`,
                success: null
            });
        }

        // Автоматически берем название из VK, если не указано
        if (!group_name && data.response && data.response.groups && data.response.groups[0]) {
            group_name = data.response.groups[0].name;
        } else if (!group_name) {
            group_name = `Группа ${group_id}`;
        }

        await db.query(
            'INSERT INTO vk_groups (group_id, group_name, access_token) VALUES ($1, $2, $3)',
            [group_id, group_name, access_token]
        );

        // Динамически запускаем бота сразу (без перезапуска сервера)
        try {
            const botInstance = createBotInstance(access_token, group_id, group_name);
            await botInstance.updates.start();
            global.bots[group_id] = botInstance;
            console.log(`🚀 Бот динамически запущен: ${group_name}`);
        } catch (botErr) {
            console.error(`⚠️ Не удалось запустить бота: ${botErr.message}`);
        }

        const result = await db.query('SELECT * FROM vk_groups ORDER BY created_at DESC');
        res.render('groups', {
            groups: result.rows,
            error: null,
            success: `✅ Группа "${group_name}" добавлена и запущена!`
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
                console.log(`🛑 Бот остановлен: ${groupRes.rows[0].group_name}`);
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
                    console.log(`⏸️ Бот отключен: ${group.group_name}`);
                }
            } else {
                // Включаем — запускаем бота
                try {
                    const botInstance = createBotInstance(group.access_token, group.group_id, group.group_name);
                    await botInstance.updates.start();
                    global.bots[group.group_id] = botInstance;
                    console.log(`▶️ Бот включен: ${group.group_name}`);
                } catch (botErr) {
                    console.error(`⚠️ Ошибка запуска: ${botErr.message}`);
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
        if (course) {
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

        if (course) {
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

module.exports = router;