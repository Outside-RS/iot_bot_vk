const express = require('express');
const router = express.Router();
const { db, getEmbedding } = require('../database');

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

router.post('/login', (req, res) => {
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
        res.render('dashboard', { count: ticketCount.rows[0].count });
    } catch (e) {
        res.send('Ошибка БД: ' + e.message);
    }
});

// === БАЗА ЗНАНИЙ (FAQ) ===

// 1. Просмотр списка
router.get('/faq', requireAuth, noCache, async (req, res) => {
    try {
        // Получаем все вопросы, сортируем по ID (новые внизу)
        const result = await db.query('SELECT * FROM faq ORDER BY id DESC');
        res.render('faq', {
            faq: result.rows,
            error: null,
            success: null
        });
    } catch (e) {
        res.send('Ошибка: ' + e.message);
    }
});

// 2. Добавление вопроса
router.post('/faq/add', requireAuth, noCache, async (req, res) => {
    const { category, question, answer, keywords } = req.body;

    try {
        // 1. Генерируем вектор
        // Склеиваем вопрос и ключевые слова для лучшего поиска
        const textForVector = question + (keywords ? " " + keywords : "");
        const vector = await getEmbedding(textForVector);

        if (!vector) {
            // Если Ollama не ответила, мы НЕ сохраняем вопрос, чтобы не портить базу
            // Либо можно сохранить, но предупредить. Давай не сохранять для надежности.
            const result = await db.query('SELECT * FROM faq ORDER BY id DESC');
            return res.render('faq', {
                faq: result.rows,
                error: '❌ Ошибка Ollama: Вектор не создан. Проверьте, запущена ли нейросеть.',
                success: null
            });
        }

        // 2. Сохраняем в базу
        await db.query(
            `INSERT INTO faq (category, question, answer, keywords, embedding) VALUES ($1, $2, $3, $4, $5)`,
            [category, question, answer, keywords, JSON.stringify(vector)]
        );

        // 3. Перезагружаем страницу с успехом
        const result = await db.query('SELECT * FROM faq ORDER BY id DESC');
        res.render('faq', {
            faq: result.rows,
            error: null,
            success: '✅ Вопрос успешно добавлен и индексирован!'
        });

    } catch (e) {
        res.send('Ошибка сохранения: ' + e.message);
    }
});

// 3. Удаление вопроса
router.post('/faq/delete/:id', requireAuth, noCache, async (req, res) => {
    try {
        await db.query('DELETE FROM faq WHERE id = $1', [req.params.id]);
        res.redirect('/faq');
    } catch (e) {
        res.send('Ошибка удаления: ' + e.message);
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
        res.render('edit_faq', { item: result.rows[0] });
    } catch (e) {
        res.send('Ошибка: ' + e.message);
    }
});

// 2. Сохранить изменения
router.post('/faq/edit/:id', requireAuth, noCache, async (req, res) => {
    const { category, question, answer, keywords } = req.body;
    const id = req.params.id;

    try {
        // Обязательно генерируем новый вектор, так как текст вопроса мог измениться
        const textForVector = question + (keywords ? " " + keywords : "");
        const vector = await getEmbedding(textForVector);

        if (!vector) {
            return res.send('❌ Ошибка: Не удалось обновить вектор (Ollama не отвечает). Изменения не сохранены, чтобы не ломать поиск.');
        }

        await db.query(
            `UPDATE faq 
             SET category = $1, question = $2, answer = $3, keywords = $4, embedding = $5
             WHERE id = $6`,
            [category, question, answer, keywords, JSON.stringify(vector), id]
        );

        res.redirect('/faq'); // Возвращаемся к списку
    } catch (e) {
        res.send('Ошибка обновления: ' + e.message);
    }
});

// Импорт для рассылки
const { VK } = require('vk-io');
const vkAdmin = new VK({ token: process.env.VK_TOKEN });

// === ТЬЮТОРЫ ===

// Страница редактирования тьютора
router.get('/tutors/edit/:code', requireAuth, noCache, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM operator_codes WHERE code = $1', [req.params.code]);
        if (result.rows.length === 0) return res.send('Код не найден');
        res.render('edit_tutor', { tutor: result.rows[0] });
    } catch (e) {
        res.send('Ошибка: ' + e.message);
    }
});

// Сохранение тьютора
router.post('/tutors/edit/:code', requireAuth, async (req, res) => {
    const { name, groups } = req.body;
    try {
        const groupArray = groups.split(',').map(s => s.trim().toUpperCase());
        const pgArray = `{${groupArray.join(',')}}`;

        await db.query(
            'UPDATE operator_codes SET tutor_name = $1, allowed_groups = $2 WHERE code = $3',
            [name, pgArray, req.params.code]
        );
        res.redirect('/tutors');
    } catch (e) {
        res.send('Ошибка обновления: ' + e.message);
    }
});

router.get('/tutors', requireAuth, noCache, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM operator_codes ORDER BY code ASC');
        res.render('tutors', { tutors: result.rows });
    } catch (e) {
        res.send('Ошибка: ' + e.message);
    }
});

router.post('/tutors/add', requireAuth, noCache, async (req, res) => {
    const { name, groups, code } = req.body;
    try {
        // Превращаем строку "РИ-101, РИ-102" в массив для Postgres: "{РИ-101,РИ-102}"
        const groupArray = groups.split(',').map(s => s.trim().toUpperCase());
        const pgArray = `{${groupArray.join(',')}}`;

        await db.query(
            'INSERT INTO operator_codes (code, tutor_name, allowed_groups) VALUES ($1, $2, $3)',
            [code, name, pgArray]
        );
        res.redirect('/tutors');
    } catch (e) {
        res.send('Ошибка (возможно, такой код уже есть): ' + e.message);
    }
});

router.post('/tutors/delete/:code', requireAuth, noCache, async (req, res) => {
    try {
        await db.query('DELETE FROM operator_codes WHERE code = $1', [req.params.code]);
        res.redirect('/tutors');
    } catch (e) {
        res.send('Ошибка удаления: ' + e.message);
    }
});

// === РАССЫЛКА ===

router.get('/broadcast', requireAuth, noCache, (req, res) => {
    res.render('broadcast');
});

router.post('/broadcast/send', requireAuth, async (req, res) => {
    const { message, target, group_number } = req.body;

    (async () => {
        try {
            console.log(`🚀 Рассылка запущена. Цель: ${target}`);
            let query = '';
            let params = [];

            // Выбираем получателей
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
                    await vkAdmin.api.messages.send({
                        peer_id: user.vk_id,
                        message: `📢 РАССЫЛКА:\n\n${message}`,
                        random_id: 0
                    });
                    count++;
                    await new Promise(r => setTimeout(r, 50)); // Анти-спам
                } catch (err) {
                    // Игнорируем тех, кто заблочил бота
                }
            }
            console.log(`✅ Рассылка завершена. Доставлено: ${count}`);
        } catch (e) {
            console.error('Ошибка рассылки:', e);
        }
    })();

    res.send(`
        <h1>🚀 Рассылка запущена!</h1>
        <p>Цель: ${target === 'group' ? group_number : target}</p>
        <a href="/">Вернуться</a>
    `);
});

module.exports = router;