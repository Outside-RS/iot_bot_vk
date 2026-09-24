/**
 * Комплексные тесты для VK Bot (Этап 2: AI-слой)
 * 
 * Запуск: node --test tests/test_all.js
 * 
 * Категории:
 *  1. Юнит-тесты ai_service.js (cleanResponse, buildSystemPrompt, prepareMessages)
 *  2. Интеграционные тесты БД (ai_queue, SKIP LOCKED, Poison Pill)
 *  3. Тесты безопасности (SQL-инъекции, XSS, переполнение)
 *  4. Тесты бизнес-логики (Circuit Breaker, EWT, спам-защита)
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ═══════════════════════════════════════════════════════
// 1. ЮНИТ-ТЕСТЫ: ai_service.js
// ═══════════════════════════════════════════════════════

const { _test } = require('../ai_service');
const { cleanResponse, buildSystemPrompt, prepareMessages } = _test;

describe('ai_service.js — cleanResponse', () => {
    it('Оставляет чистый русский текст без изменений', () => {
        const input = 'Привет! Это ответ на русском языке.';
        assert.equal(cleanResponse(input), input);
    });

    it('Удаляет китайские символы (CJK)', () => {
        const input = 'Для получения информации 建议你查询天气预报 обратитесь к администратору.';
        const result = cleanResponse(input);
        assert.ok(!result.includes('建议'));
        assert.ok(result.includes('Для получения информации'));
        assert.ok(result.includes('обратитесь к администратору'));
    });

    it('Удаляет вьетнамские диакритики', () => {
        const input = 'К сожалению thời tiết я не могу ответить.';
        const result = cleanResponse(input);
        assert.ok(!result.includes('thời'));
        assert.ok(!result.includes('tiết'));
    });

    it('Убирает двойные пробелы после очистки', () => {
        const input = 'Текст 中文 на русском.';
        const result = cleanResponse(input);
        assert.ok(!result.includes('  '));
    });

    it('Возвращает fallback при полностью иностранном ответе', () => {
        const input = '建议你查询天气预报以获得准确信息';
        const result = cleanResponse(input);
        assert.equal(result, 'К сожалению, я не могу ответить на этот вопрос. Пожалуйста, обратитесь к администратору.');
    });

    it('Возвращает fallback при слишком коротком очищенном тексте', () => {
        const input = 'Да 中文文本很长很长';
        const result = cleanResponse(input);
        assert.equal(result, 'К сожалению, я не могу ответить на этот вопрос. Пожалуйста, обратитесь к администратору.');
    });

    it('Не удаляет базовую латиницу (API, URL, email)', () => {
        const input = 'Проверьте API на сайте career.urfu.ru или напишите email.';
        const result = cleanResponse(input);
        assert.ok(result.includes('API'));
        assert.ok(result.includes('career'));
        assert.ok(result.includes('email'));
    });

    it('Корректно обрабатывает пунктуацию после удаления', () => {
        const input = 'Ответ 中文, продолжение.';
        const result = cleanResponse(input);
        assert.ok(!result.includes(' ,'));
    });
});

describe('ai_service.js — buildSystemPrompt', () => {
    it('Включает контекст FAQ когда он передан', () => {
        const prompt = buildSystemPrompt('Стажировки: career.urfu.ru');
        assert.ok(prompt.includes('Стажировки: career.urfu.ru'));
        assert.ok(prompt.includes('КОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ'));
    });

    it('Сообщает об отсутствии контекста при пустой строке', () => {
        const prompt = buildSystemPrompt('');
        assert.ok(prompt.includes('не содержит информации'));
    });

    it('Сообщает об отсутствии контекста при null', () => {
        const prompt = buildSystemPrompt(null);
        assert.ok(prompt.includes('не содержит информации'));
    });

    it('Содержит инструкцию ТОЛЬКО на русском', () => {
        const prompt = buildSystemPrompt('');
        assert.ok(prompt.includes('СТРОГО'));
        assert.ok(prompt.includes('ТОЛЬКО на русском'));
    });

    it('Содержит лимит по длине ответа', () => {
        const prompt = buildSystemPrompt('');
        assert.ok(prompt.includes('Отвечай кратко'));
    });

    it('Содержит ограничение тематики (только университет)', () => {
        const prompt = buildSystemPrompt('');
        assert.ok(prompt.includes('связанные с учёбой и университетской жизнью'));
    });

    it('Содержит запрет на написание кода', () => {
        const prompt = buildSystemPrompt('');
        assert.ok(prompt.includes('ЗАПРЕЩЕНО отвечать на технические запросы'));
        assert.ok(prompt.includes('написать код'));
    });

    it('Содержит инструкцию отказа на нерелевантные темы', () => {
        const prompt = buildSystemPrompt('');
        assert.ok(prompt.includes('программировани'));
        assert.ok(prompt.includes('Я могу помочь только по вопросам, связанным с университетом.'));
    });
});

describe('ai_service.js — prepareMessages', () => {
    it('Добавляет системный промпт первым сообщением', () => {
        const messages = [{ role: 'user', content: 'Привет' }];
        const result = prepareMessages(messages, '');
        assert.equal(result[0].role, 'system');
        assert.equal(result.length, 2);
    });

    it('Обрезает историю до 10 последних сообщений (5 пар)', () => {
        const messages = Array.from({ length: 14 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `Сообщение ${i}`
        }));
        const result = prepareMessages(messages, '');
        // system + 10 last = 11
        assert.equal(result.length, 11);
        assert.ok(result[1].content.includes('[ВОПРОС СТУДЕНТА ОБ УНИВЕРСИТЕТЕ]: Сообщение 4')); // первое из последних 10
    });

    it('Работает с пустым массивом сообщений', () => {
        const result = prepareMessages([], '');
        assert.equal(result.length, 1);
        assert.equal(result[0].role, 'system');
    });

    it('Передаёт FAQ-контекст в системный промпт', () => {
        const result = prepareMessages(
            [{ role: 'user', content: 'тест' }],
            'Вопрос: Где стажировка?\nОтвет: career.urfu.ru'
        );
        assert.ok(result[0].content.includes('career.urfu.ru'));
    });
});

// ═══════════════════════════════════════════════════════
// 2. ИНТЕГРАЦИОННЫЕ ТЕСТЫ: База данных
// ═══════════════════════════════════════════════════════

const { db } = require('../database');

describe('База данных — ai_queue', () => {
    const TEST_VK_ID = 999999999;
    const TEST_GROUP_ID = 123456789;

    before(async () => {
        // Создаём тестового пользователя
        await db.query(`
            INSERT INTO users (vk_id, role, full_name, group_number, state, ai_context)
            VALUES ($1, 'student', 'Тест Тестов', 'ТС-000000', 'main_menu', '[]')
            ON CONFLICT (vk_id) DO UPDATE SET state = 'main_menu', ai_context = '[]'
        `, [TEST_VK_ID]);
    });

    after(async () => {
        // Очистка
        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
        await db.query('DELETE FROM users WHERE vk_id = $1', [TEST_VK_ID]);
    });

    it('INSERT в ai_queue корректно создаёт задачу', async () => {
        const res = await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [TEST_VK_ID, TEST_GROUP_ID, JSON.stringify([{ role: 'user', content: 'Тест' }]), '']
        );
        assert.equal(res.rows.length, 1);
        assert.equal(res.rows[0].status, 'pending');
        assert.equal(res.rows[0].attempts, 0);

        // Очистка
        await db.query('DELETE FROM ai_queue WHERE id = $1', [res.rows[0].id]);
    });

    it('SELECT FOR UPDATE SKIP LOCKED работает в транзакции', async () => {
        // Вставляем задачу
        await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context)
             VALUES ($1, $2, '[]', '')`,
            [TEST_VK_ID, TEST_GROUP_ID]
        );

        const client1 = await db.connect();
        const client2 = await db.connect();

        try {
            // Транзакция 1 блокирует строку
            await client1.query('BEGIN');
            const res1 = await client1.query(`
                SELECT * FROM ai_queue WHERE status = 'pending'
                ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
            `);
            assert.equal(res1.rows.length, 1);

            // Транзакция 2 НЕ видит заблокированную строку
            await client2.query('BEGIN');
            const res2 = await client2.query(`
                SELECT * FROM ai_queue WHERE status = 'pending'
                ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
            `);
            assert.equal(res2.rows.length, 0, 'Вторая транзакция должна получить 0 строк (SKIP LOCKED)');

            await client1.query('ROLLBACK');
            await client2.query('ROLLBACK');
        } finally {
            client1.release();
            client2.release();
        }

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
    });

    it('Attempts корректно инкрементируется', async () => {
        const ins = await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context)
             VALUES ($1, $2, '[]', '') RETURNING id`,
            [TEST_VK_ID, TEST_GROUP_ID]
        );
        const taskId = ins.rows[0].id;

        await db.query(`UPDATE ai_queue SET attempts = attempts + 1 WHERE id = $1`, [taskId]);
        await db.query(`UPDATE ai_queue SET attempts = attempts + 1 WHERE id = $1`, [taskId]);

        const res = await db.query('SELECT attempts FROM ai_queue WHERE id = $1', [taskId]);
        assert.equal(res.rows[0].attempts, 2);

        await db.query('DELETE FROM ai_queue WHERE id = $1', [taskId]);
    });

    it('Poison Pill: задача с attempts >= 2 переводится в error', async () => {
        const ins = await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context, attempts)
             VALUES ($1, $2, '[]', '', 2) RETURNING id`,
            [TEST_VK_ID, TEST_GROUP_ID]
        );
        const taskId = ins.rows[0].id;

        // Имитируем логику Worker'а
        const task = (await db.query('SELECT * FROM ai_queue WHERE id = $1', [taskId])).rows[0];
        if (task.attempts >= 2) {
            await db.query("UPDATE ai_queue SET status = 'error' WHERE id = $1", [taskId]);
        }

        const res = await db.query('SELECT status FROM ai_queue WHERE id = $1', [taskId]);
        assert.equal(res.rows[0].status, 'error');

        await db.query('DELETE FROM ai_queue WHERE id = $1', [taskId]);
    });

    it('CASCADE: удаление пользователя удаляет его задачи из очереди', async () => {
        const tempVkId = 888888888;
        await db.query(
            `INSERT INTO users (vk_id, state) VALUES ($1, 'main_menu') ON CONFLICT DO NOTHING`,
            [tempVkId]
        );
        await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context)
             VALUES ($1, $2, '[]', '')`,
            [tempVkId, TEST_GROUP_ID]
        );

        await db.query('DELETE FROM users WHERE vk_id = $1', [tempVkId]);

        const res = await db.query('SELECT * FROM ai_queue WHERE vk_id = $1', [tempVkId]);
        assert.equal(res.rows.length, 0, 'Задачи должны удалиться каскадно');
    });
});

// ═══════════════════════════════════════════════════════
// 3. ТЕСТЫ БЕЗОПАСНОСТИ
// ═══════════════════════════════════════════════════════

describe('Безопасность — SQL-инъекции', () => {
    const TEST_VK_ID = 999999998;

    before(async () => {
        await db.query(
            `INSERT INTO users (vk_id, state, full_name, group_number)
             VALUES ($1, 'main_menu', 'Тест', 'ТС-000000')
             ON CONFLICT (vk_id) DO NOTHING`,
            [TEST_VK_ID]
        );
    });

    after(async () => {
        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
        await db.query('DELETE FROM users WHERE vk_id = $1', [TEST_VK_ID]);
    });

    it('SQL-инъекция в ai_context не выполняется', async () => {
        const maliciousContext = JSON.stringify([{
            role: 'user',
            content: "'; DROP TABLE users; --"
        }]);

        const res = await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context)
             VALUES ($1, 123, $2, '') RETURNING id`,
            [TEST_VK_ID, maliciousContext]
        );
        assert.ok(res.rows[0].id > 0);

        // Проверяем, что таблица users не удалена
        const users = await db.query('SELECT COUNT(*) FROM users');
        assert.ok(parseInt(users.rows[0].count) > 0, 'Таблица users должна существовать');

        await db.query('DELETE FROM ai_queue WHERE id = $1', [res.rows[0].id]);
    });

    it('SQL-инъекция в faq_context не выполняется', async () => {
        const malicious = "'; UPDATE users SET role='operator' WHERE vk_id=1; --";

        const res = await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context)
             VALUES ($1, 123, '[]', $2) RETURNING id`,
            [TEST_VK_ID, malicious]
        );
        assert.ok(res.rows[0].id > 0);

        // Проверяем, что роль тестового юзера не изменилась
        const user = await db.query('SELECT role FROM users WHERE vk_id = $1', [TEST_VK_ID]);
        assert.equal(user.rows[0].role, 'student');

        await db.query('DELETE FROM ai_queue WHERE id = $1', [res.rows[0].id]);
    });

    it('XSS в тексте вопроса сохраняется как plain text', async () => {
        const xss = '<script>alert("hacked")</script>';
        const res = await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context)
             VALUES ($1, 123, $2, '') RETURNING ai_context`,
            [TEST_VK_ID, JSON.stringify([{ role: 'user', content: xss }])]
        );
        const stored = res.rows[0].ai_context[0].content;
        assert.equal(stored, xss, 'XSS должен сохраниться как текст, не выполняясь');

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
    });
});

// ═══════════════════════════════════════════════════════
// 4. ТЕСТЫ БИЗНЕС-ЛОГИКИ
// ═══════════════════════════════════════════════════════

describe('Бизнес-логика — Circuit Breaker (лимит 50 задач)', () => {
    const TEST_VK_ID = 999999997;

    before(async () => {
        await db.query(
            `INSERT INTO users (vk_id, state, full_name) VALUES ($1, 'main_menu', 'CB-Тест')
             ON CONFLICT (vk_id) DO NOTHING`,
            [TEST_VK_ID]
        );
    });

    after(async () => {
        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
        await db.query('DELETE FROM users WHERE vk_id = $1', [TEST_VK_ID]);
    });

    it('Считает pending-задачи корректно', async () => {
        // Вставляем 3 задачи
        for (let i = 0; i < 3; i++) {
            await db.query(
                `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context)
                 VALUES ($1, 123, '[]', '')`,
                [TEST_VK_ID]
            );
        }

        const countRes = await db.query("SELECT COUNT(*) FROM ai_queue WHERE status = 'pending'");
        const count = parseInt(countRes.rows[0].count);
        assert.ok(count >= 3, `Должно быть >= 3 pending задач, а получено ${count}`);

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
    });

    it('EWT рассчитывается корректно: Math.ceil((count+1)/10)', () => {
        // Формула из bot.js
        assert.equal(Math.ceil((0 + 1) / 10), 1);   // 0 в очереди → ~1 мин
        assert.equal(Math.ceil((9 + 1) / 10), 1);   // 9 в очереди → ~1 мин
        assert.equal(Math.ceil((10 + 1) / 10), 2);  // 10 в очереди → ~2 мин
        assert.equal(Math.ceil((49 + 1) / 10), 5);  // 49 в очереди → ~5 мин
    });
});

describe('Бизнес-логика — Спам-защита', () => {
    const TEST_VK_ID = 999999996;

    before(async () => {
        await db.query(
            `INSERT INTO users (vk_id, state) VALUES ($1, 'ai_dialogue_mode')
             ON CONFLICT (vk_id) DO UPDATE SET state = 'ai_dialogue_mode'`,
            [TEST_VK_ID]
        );
    });

    after(async () => {
        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
        await db.query('DELETE FROM users WHERE vk_id = $1', [TEST_VK_ID]);
    });

    it('Блокирует второй вопрос если есть pending задача', async () => {
        await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context, status)
             VALUES ($1, 123, '[]', '', 'pending')`,
            [TEST_VK_ID]
        );

        const res = await db.query(
            "SELECT id FROM ai_queue WHERE vk_id = $1 AND status IN ('pending', 'processing')",
            [TEST_VK_ID]
        );
        assert.ok(res.rows.length > 0, 'Должна найтись pending задача → блокировка');

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
    });

    it('Блокирует второй вопрос если есть processing задача', async () => {
        await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context, status)
             VALUES ($1, 123, '[]', '', 'processing')`,
            [TEST_VK_ID]
        );

        const res = await db.query(
            "SELECT id FROM ai_queue WHERE vk_id = $1 AND status IN ('pending', 'processing')",
            [TEST_VK_ID]
        );
        assert.ok(res.rows.length > 0, 'Должна найтись processing задача → блокировка');

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
    });

    it('Пропускает если задача в статусе error', async () => {
        await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context, status)
             VALUES ($1, 123, '[]', '', 'error')`,
            [TEST_VK_ID]
        );

        const res = await db.query(
            "SELECT id FROM ai_queue WHERE vk_id = $1 AND status IN ('pending', 'processing')",
            [TEST_VK_ID]
        );
        assert.equal(res.rows.length, 0, 'Error-задачи не должны блокировать новые вопросы');

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
    });
});

describe('Бизнес-логика — Zombie cleanup', () => {
    const TEST_VK_ID = 999999995;

    before(async () => {
        await db.query(
            `INSERT INTO users (vk_id, state) VALUES ($1, 'main_menu')
             ON CONFLICT (vk_id) DO NOTHING`,
            [TEST_VK_ID]
        );
    });

    after(async () => {
        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
        await db.query('DELETE FROM users WHERE vk_id = $1', [TEST_VK_ID]);
    });

    // Запрос-под-тестом: та же логика, что в ai_worker.cleanZombieTasks
    const ZOMBIE_SQL = `
        UPDATE ai_queue SET status = 'pending', started_at = NULL
        WHERE status = 'processing'
          AND started_at IS NOT NULL
          AND started_at < NOW() - INTERVAL '10 minutes'
          AND vk_id = $1
        RETURNING id
    `;

    it('Задача, висящая в работе больше 10 минут, возвращается в pending', async () => {
        await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context, status, created_at, started_at)
             VALUES ($1, 123, '[]', '', 'processing', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '15 minutes')`,
            [TEST_VK_ID]
        );

        const result = await db.query(ZOMBIE_SQL, [TEST_VK_ID]);
        assert.ok(result.rowCount > 0, 'Зависшая задача должна вернуться в pending');

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
    });

    it('Свежевзятая задача НЕ затрагивается', async () => {
        await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context, status, created_at, started_at)
             VALUES ($1, 123, '[]', '', 'processing', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '2 minutes')`,
            [TEST_VK_ID]
        );

        const result = await db.query(ZOMBIE_SQL, [TEST_VK_ID]);
        assert.equal(result.rowCount, 0, 'Свежая задача не должна сбрасываться');

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
    });

    // Регрессия на исходный баг: чистильщик смотрел на created_at (время
    // постановки в очередь). Задача, пролежавшая в длинной очереди дольше
    // таймаута, сбрасывалась сразу после взятия в работу и обрабатывалась
    // дважды — студент получал два ответа.
    it('Долго ждавшая в очереди, но только что взятая задача НЕ сбрасывается', async () => {
        await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context, status, created_at, started_at)
             VALUES ($1, 123, '[]', '', 'processing', NOW() - INTERVAL '45 minutes', NOW() - INTERVAL '10 seconds')`,
            [TEST_VK_ID]
        );

        const result = await db.query(ZOMBIE_SQL, [TEST_VK_ID]);
        assert.equal(result.rowCount, 0, 'Задача в работе 10 секунд не должна считаться зависшей');

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
    });

    it('Задача без started_at (не взятая в работу) не трогается', async () => {
        await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context, status, created_at)
             VALUES ($1, 123, '[]', '', 'pending', NOW() - INTERVAL '30 minutes')`,
            [TEST_VK_ID]
        );

        const result = await db.query(ZOMBIE_SQL, [TEST_VK_ID]);
        assert.equal(result.rowCount, 0);

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [TEST_VK_ID]);
    });
});

// ═══════════════════════════════════════════════════════
// 5. ТЕСТЫ ЦЕЛОСТНОСТИ ДАННЫХ
// ═══════════════════════════════════════════════════════

describe('Целостность данных', () => {
    it('ai_context корректно сериализуется/десериализуется как JSONB', async () => {
        const testVk = 999999994;
        const complexContext = [
            { role: 'user', content: 'Привет 👋' },
            { role: 'assistant', content: 'Здравствуйте!', model: 'Ollama' },
            { role: 'user', content: 'Вопрос с "кавычками" и спец.символами: <>&' }
        ];

        await db.query(
            `INSERT INTO users (vk_id, state, ai_context) VALUES ($1, 'main_menu', $2)
             ON CONFLICT (vk_id) DO UPDATE SET ai_context = $2`,
            [testVk, JSON.stringify(complexContext)]
        );

        const res = await db.query('SELECT ai_context FROM users WHERE vk_id = $1', [testVk]);
        const restored = res.rows[0].ai_context;

        assert.equal(restored.length, 3);
        assert.equal(restored[0].content, 'Привет 👋');
        assert.equal(restored[2].content, 'Вопрос с "кавычками" и спец.символами: <>&');

        await db.query('DELETE FROM users WHERE vk_id = $1', [testVk]);
    });

    it('vk_group_id BIGINT корректно обрабатывает большие числа', async () => {
        const testVk = 999999993;
        const bigGroupId = 9007199254740991; // Number.MAX_SAFE_INTEGER

        await db.query(
            `INSERT INTO users (vk_id, state) VALUES ($1, 'main_menu')
             ON CONFLICT (vk_id) DO NOTHING`,
            [testVk]
        );

        const res = await db.query(
            `INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context)
             VALUES ($1, $2, '[]', '') RETURNING vk_group_id`,
            [testVk, bigGroupId]
        );

        // pg возвращает BIGINT как string
        assert.equal(res.rows[0].vk_group_id, bigGroupId.toString());

        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [testVk]);
        await db.query('DELETE FROM users WHERE vk_id = $1', [testVk]);
    });
});

// ═══════════════════════════════════════════════════════
// 6. ТЕСТЫ: app_settings (Singleton-таблица)
// ═══════════════════════════════════════════════════════

describe('app_settings — Singleton-таблица', () => {
    it('Таблица содержит ровно одну строку', async () => {
        const res = await db.query('SELECT COUNT(*) FROM app_settings');
        assert.equal(parseInt(res.rows[0].count), 1);
    });

    it('Невозможно вставить вторую строку (PK = TRUE)', async () => {
        await assert.rejects(async () => {
            await db.query("INSERT INTO app_settings (id) VALUES (TRUE)");
        }, { message: /duplicate key|unique constraint|already exists/i });
    });

    it('UPDATE корректно обновляет модель Ollama', async () => {
        // Сохраняем текущее значение
        const before = await db.query('SELECT ollama_model FROM app_settings');
        const original = before.rows[0].ollama_model;

        await db.query("UPDATE app_settings SET ollama_model = 'llama3' WHERE id = TRUE");
        const res = await db.query('SELECT ollama_model FROM app_settings WHERE id = TRUE');
        assert.equal(res.rows[0].ollama_model, 'llama3');

        // Восстанавливаем
        await db.query("UPDATE app_settings SET ollama_model = $1 WHERE id = TRUE", [original]);
    });

    it('COALESCE(NULLIF) не стирает gigachat_key при пустой строке', async () => {
        // Сохраняем текущий
        const before = await db.query('SELECT gigachat_key FROM app_settings');
        const originalKey = before.rows[0].gigachat_key;

        // Попытка обновить пустой строкой — ключ должен сохраниться
        await db.query(`
            UPDATE app_settings SET
                gigachat_key = COALESCE(NULLIF($1, ''), app_settings.gigachat_key)
            WHERE id = TRUE
        `, ['']);

        const res = await db.query('SELECT gigachat_key FROM app_settings WHERE id = TRUE');
        assert.equal(res.rows[0].gigachat_key, originalKey, 'Ключ не должен стираться пустой строкой');
    });

    it('invalidateSettingsCache() и resetGigaChatToken() доступны из ai_service', () => {
        const { invalidateSettingsCache, resetGigaChatToken } = require('../ai_service');
        assert.equal(typeof invalidateSettingsCache, 'function');
        assert.equal(typeof resetGigaChatToken, 'function');
        // Вызов не должен падать
        invalidateSettingsCache();
        resetGigaChatToken();
    });

    it('getSettings() возвращает данные из БД', async () => {
        const { getSettings, invalidateSettingsCache } = require('../ai_service');
        invalidateSettingsCache(); // Сбрасываем кэш чтобы получить свежие
        const settings = await getSettings();
        assert.ok(settings.ollama_url);
        assert.ok(settings.ollama_model);
    });
});

// ═══════════════════════════════════════════════════════
// 6. ЛОГИКА ВЫБОРА ПРОВАЙДЕРА (ai_worker.generate)
//    Провайдеры подменяются заглушками — сеть и модели не нужны
// ═══════════════════════════════════════════════════════

const worker = require('../ai_worker');
const { generate, providers, setBusy } = worker._test;

describe('ai_worker — выбор провайдера', () => {
    const task = { id: 1, ai_context: [{ role: 'user', content: 'вопрос' }], faq_context: '' };
    const original = { ...providers };

    const stubAnswer = (provider) => async () => ({ text: 'ответ', provider, model: provider, tokens: 100 });
    const stubFail = (message, extra = {}) => async () => { throw Object.assign(new Error(message), extra); };

    beforeEach(() => {
        setBusy(false, false);
        providers.getGigaChatChain = async () => [{ class: 'lite', id: 'GigaChat-2' }];
        providers.askGigaChat = stubAnswer('GigaChat');
        providers.askOllama = stubAnswer('Ollama');
    });

    after(() => {
        Object.assign(providers, original);
        setBusy(false, false);
    });

    it('Основной провайдер — GigaChat, когда он свободен', async () => {
        let ollamaCalled = false;
        providers.askOllama = async () => { ollamaCalled = true; return stubAnswer('Ollama')(); };

        const res = await generate(task);

        assert.equal(res.provider, 'GigaChat');
        assert.equal(ollamaCalled, false, 'Локальная модель не должна вызываться при живом облаке');
    });

    it('При обычном сбое GigaChat уходим на резервную Ollama', async () => {
        providers.askGigaChat = stubFail('GigaChat API error 500');

        const res = await generate(task);
        assert.equal(res.provider, 'Ollama');
    });

    it('При исчерпании квоты пробуем следующий класс модели, а не резерв', async () => {
        providers.getGigaChatChain = async () => [
            { class: 'lite', id: 'GigaChat-2' },
            { class: 'pro', id: 'GigaChat-2-Pro' }
        ];
        const tried = [];
        providers.askGigaChat = async (ctx, faq, modelId) => {
            tried.push(modelId);
            if (modelId === 'GigaChat-2') {
                throw Object.assign(new Error('quota'), { quotaExhausted: true });
            }
            return { text: 'ответ', provider: 'GigaChat', model: modelId, tokens: 50 };
        };

        const res = await generate(task);

        assert.deepEqual(tried, ['GigaChat-2', 'GigaChat-2-Pro']);
        assert.equal(res.model, 'GigaChat-2-Pro');
    });

    it('Когда облачный слот занят, задачу берёт Ollama', async () => {
        setBusy(true, false);

        const res = await generate(task);
        assert.equal(res.provider, 'Ollama');
    });

    // Регрессия на исходный баг: занятость провайдеров считалась сбоем задачи.
    // Два тика по 3 секунды доводили attempts до 2, и второй человек в очереди
    // получал «системную ошибку» вместо ответа.
    it('Когда заняты оба слота — это не сбой задачи, а ожидание', async () => {
        setBusy(true, true);

        await assert.rejects(
            () => generate(task),
            (err) => {
                assert.equal(err.noCapacity, true, 'Ошибка должна быть помечена как отсутствие свободного слота');
                return true;
            }
        );
    });

    it('Если все квоты исчерпаны и резерв недоступен — это настоящий сбой', async () => {
        providers.getGigaChatChain = async () => [];
        providers.askOllama = stubFail('fetch failed');

        await assert.rejects(
            () => generate(task),
            (err) => {
                assert.ok(!err.noCapacity, 'Это должен быть сбой, а не ожидание слота');
                return true;
            }
        );
    });
});

describe('ai_worker — оценка времени ожидания', () => {
    it('Без замеров используется значение по умолчанию', () => {
        const stats = worker.getQueueStats();
        assert.ok(stats.avgSeconds > 0);
    });

    it('Среднее считается по последним замерам', () => {
        const { recordDuration, averageDuration } = worker._test;
        recordDuration(10);
        recordDuration(20);
        const avg = averageDuration();
        assert.ok(avg > 0 && avg < 60, `Ожидали разумное среднее, получили ${avg}`);
    });
});

describe('Устойчивость к падению БД', () => {
    // Регрессия: без обработчика 'error' на пуле остановка PostgreSQL
    // (код 57P01) завершала процесс бота целиком — «Unhandled 'error' event»
    it('У пула соединений есть обработчик события error', () => {
        const { db } = require('../database');
        assert.ok(db.listenerCount('error') > 0, 'Пул обязан слушать error, иначе обрыв связи с базой роняет процесс');
    });
});

// ═══════════════════════════════════════════════════════
// 7. ЗАЩИТА ОТ ВЫДУМАННЫХ ФАКТОВ (fact_guard.js)
// ═══════════════════════════════════════════════════════

const factGuard = require('../fact_guard');

describe('fact_guard — распознавание контактов', () => {
    const types = (text) => factGuard.extractFacts(text).map(f => `${f.type}:${f.raw}`);

    it('Почта не дублируется ссылкой на её домен', () => {
        assert.deepEqual(types('Пишите на m.s.kurochkina@urfu.ru'), ['email:m.s.kurochkina@urfu.ru']);
    });

    it('Точка в конце предложения не входит в ссылку', () => {
        assert.deepEqual(types('Справочник: rtf.urfu.ru/ru/kontakty/.'), ['url:rtf.urfu.ru/ru/kontakty/']);
    });

    it('Телефоны в разных форматах', () => {
        const t = types('Звоните +7 (343) 375-44-80 или 375-41-99');
        assert.ok(t.includes('phone:+7 (343) 375-44-80'));
        assert.ok(t.includes('phone:375-41-99'));
    });

    it('Аудитории со словом и без', () => {
        const t = types('Деканат в аудитории Р-219, тьюторы в Р-138А, приём в ауд. 119');
        assert.ok(t.includes('room:Р-219'));
        assert.ok(t.includes('room:Р-138А'));
        assert.ok(t.includes('room:119'));
    });

    it('Номер группы, даты и годы — не контакты', () => {
        assert.deepEqual(types('Группа РИ-140944, занятия с 1 сентября 2026 года, стипендия 25-го числа'), []);
    });
});

describe('fact_guard — проверка ответа модели', () => {
    const knowledge = [
        'Деканат ИРИТ-РТФ: ул. Мира, 32, аудитория Р-219. Специалист — Курочкина Марина Сергеевна, m.s.kurochkina@urfu.ru.',
        'Справочник сотрудников: rtf.urfu.ru/ru/kontakty/. Портал: urfu.ru/ru/international/. Телефон 375-44-80.'
    ].join('\n');
    const known = factGuard.buildKnownFacts(knowledge);

    // Регрессия на реальный случай 04.09.2026
    it('Выдуманный адрес почты заменяется пометкой', () => {
        const r = factGuard.guardFacts('Адрес электронной почты деканата ИРИТ-РТФ: dekanat-rtf@urfu.ru.', known);
        assert.ok(!r.text.includes('dekanat-rtf@urfu.ru'));
        assert.ok(r.text.includes(factGuard.PLACEHOLDER));
        assert.ok(r.text.includes(factGuard.NOTE));
        assert.deepEqual(r.removed, ['dekanat-rtf@urfu.ru']);
    });

    it('Контакты из базы знаний не трогаются, пояснение не добавляется', () => {
        const answer = 'Обратитесь к Курочкиной (ауд. Р-219): m.s.kurochkina@urfu.ru, тел. 375-44-80.';
        const r = factGuard.guardFacts(answer, known);
        assert.equal(r.text, answer);
        assert.deepEqual(r.removed, []);
    });

    it('Выдуманный путь на знакомом домене ловится, голый домен — нет', () => {
        const r = factGuard.guardFacts('Расписание: rtf.urfu.ru/ru/students/raspisanie, сайт — urfu.ru.', known);
        assert.deepEqual(r.removed, ['rtf.urfu.ru/ru/students/raspisanie']);
        assert.ok(r.text.includes('сайт — urfu.ru'));
    });

    it('Телефон сверяется по местному номеру, в любом формате', () => {
        const r = factGuard.guardFacts('Звоните +7 (343) 375-44-80 или 375-00-00.', known);
        assert.deepEqual(r.removed, ['375-00-00']);
    });

    it('Латинская «P» в номере аудитории считается той же аудиторией', () => {
        const r = factGuard.guardFacts('Деканат в аудитории P-219.', known);
        assert.deepEqual(r.removed, []);
    });

    it('Выдуманная аудитория заменяется', () => {
        const r = factGuard.guardFacts('Подойдите в ауд. Р-999.', known);
        assert.deepEqual(r.removed, ['Р-999']);
    });

    it('Контакт, который написал сам студент, считается проверенным', () => {
        const withUser = factGuard.buildKnownFacts(knowledge, 'Я уже писал на ivanov@urfu.ru, не отвечают');
        const r = factGuard.guardFacts('Попробуйте написать на ivanov@urfu.ru ещё раз.', withUser);
        assert.deepEqual(r.removed, []);
    });
});

describe('answer_policy — маршрут к администратору', () => {
    const { ensureAdminRoute, ADMIN_LINE } = require('../answer_policy');

    // Реальные ответы GigaChat из прогонов контрольных вопросов
    it('Без контекста дописывает кнопку, даже если модель отправила на сайт', () => {
        const text = 'Номер телефона ректора отсутствует в базе знаний. Вы можете направить запрос через официальный сайт.';
        assert.ok(ensureAdminRoute(text, { hadContext: false }).endsWith(ADMIN_LINE));
    });

    it('С контекстом дописывает, если модель сама признала, что ответа нет', () => {
        const text = 'Пароли от Wi-Fi регулярно меняются, поэтому я не могу предоставить актуальную информацию.';
        assert.ok(ensureAdminRoute(text, { hadContext: true }).endsWith(ADMIN_LINE));
    });

    // Регрессия: шаблон ждал только «нет в базе», а модель написала «в базе знаний нет»
    it('Понимает обратный порядок слов «в базе знаний нет»', () => {
        const text = 'Пароли для Wi-Fi периодически меняются, официальной информации по корпусу на улице Мира в базе знаний нет.';
        assert.ok(ensureAdminRoute(text, { hadContext: true }).endsWith(ADMIN_LINE));
    });

    it('Нормальный ответ по контексту не трогает', () => {
        const text = 'Деканат находится по адресу: ул. Мира, 32, аудитория Р-219.';
        assert.equal(ensureAdminRoute(text, { hadContext: true }), text);
    });

    it('Не дублирует, если администратор уже упомянут', () => {
        const text = 'Адреса почты деканата в базе знаний нет. Нажмите «Передать администратору».';
        assert.equal(ensureAdminRoute(text, { hadContext: false }), text);
    });

    it('Не дописывает к отказу на посторонний запрос', () => {
        const text = 'Я могу помочь только по вопросам, связанным с университетом.';
        assert.equal(ensureAdminRoute(text, { hadContext: false }), text);
    });
});

// ═══════════════════════════════════════════════════════
// 8. КОНТЕКСТ ДЛЯ ИИ И ПРОМПТ (Этап 4)
// ═══════════════════════════════════════════════════════

describe('faq_search — порог контекста для ИИ', () => {
    const { buildHints, HINT_MIN_SCORE } = require('../faq_search');
    const row = (id, score) => ({ id, question: `Вопрос ${id}`, answer: `Ответ ${id}`, score });

    // Регрессия: раньше в модель уходили все найденные записи, включая шум
    it('Записи ниже порога в контекст не попадают', () => {
        const hints = buildHints([row(1, 0.2), row(2, HINT_MIN_SCORE), row(3, 0.09), row(4, 0.05)]);
        assert.ok(hints.includes('Вопрос 1'));
        assert.ok(hints.includes('Вопрос 2'));
        assert.ok(!hints.includes('Вопрос 3'));
        assert.ok(!hints.includes('Вопрос 4'));
    });

    it('Если всё ниже порога — контекст пустой', () => {
        assert.equal(buildHints([row(1, 0.086), row(2, 0.063)]), '');
    });

    it('В контекст идёт не больше пяти записей', () => {
        const hints = buildHints([1, 2, 3, 4, 5, 6, 7].map(i => row(i, 0.3)));
        assert.equal(hints.split('\n---\n').length, 5);
    });

    it('Объединение поисков: без дублей, с лучшим score, по убыванию', () => {
        const { mergeRows } = require('../faq_search');
        const merged = mergeRows([row(1, 0.12), row(2, 0.3)], [row(1, 0.25), row(3, 0.05)]);
        assert.deepEqual(merged.map(r => r.id), [2, 1, 3]);
        assert.equal(merged.find(r => r.id === 1).score, 0.25);
    });
});

describe('ai_service — промпт и история (Этап 4)', () => {
    it('Промпт запрещает составлять контакты по аналогии', () => {
        const prompt = buildSystemPrompt('Контекст');
        assert.ok(prompt.includes('Никогда не составляй адрес почты или ссылку по аналогии'));
        assert.ok(prompt.includes('Сведения об УрФУ из собственной памяти не используй'));
    });

    it('Без контекста модель отправляет к администратору через кнопку бота', () => {
        const prompt = buildSystemPrompt('');
        assert.ok(prompt.includes('Не отвечай по памяти'));
        assert.ok(prompt.includes('«Передать администратору»'));
    });

    it('С контекстом модель предупреждена, что не все записи относятся к вопросу', () => {
        assert.ok(buildSystemPrompt('Контекст').includes('Не все они обязательно относятся к вопросу'));
    });

    it('/no_think уходит только локальной модели', () => {
        assert.ok(!buildSystemPrompt('', 'gigachat').includes('/no_think'));
        assert.ok(buildSystemPrompt('', 'ollama').startsWith('/no_think'));
    });

    it('Напоминание о правилах — только у последнего вопроса', () => {
        const res = prepareMessages([
            { role: 'user', content: 'первый' },
            { role: 'assistant', content: 'ответ' },
            { role: 'user', content: 'второй' }
        ], '');
        assert.ok(!res[1].content.includes('Напоминание'));
        assert.ok(res[3].content.includes('Напоминание'));
    });

    it('История не начинается с ответа ассистента без вопроса', () => {
        const res = prepareMessages([
            { role: 'assistant', content: 'осиротевший ответ' },
            { role: 'user', content: 'вопрос' }
        ], '');
        assert.equal(res.length, 2);
        assert.equal(res[1].role, 'user');
    });

    it('В API уходят только role и content', () => {
        const res = prepareMessages([
            { role: 'user', content: 'вопрос' },
            { role: 'assistant', content: 'ответ', model: 'GigaChat-2' },
            { role: 'user', content: 'ещё' }
        ], '');
        assert.deepEqual(Object.keys(res[2]).sort(), ['content', 'role']);
    });

    // Реальные артефакты из ответов GigaChat: ВКонтакте их не отображает
    it('cleanResponse убирает HTML и Markdown, которые VK не отображает', () => {
        const res = cleanResponse('Стипендия приходит 25-го.<br/>**Важно:** уточните в *бухгалтерии*.\n> Цитата\n### Заголовок');
        assert.ok(!res.includes('<br'));
        assert.ok(!res.includes('**'));
        assert.ok(!res.includes('*бухгалтерии*'));
        assert.ok(res.includes('бухгалтерии'));
        assert.ok(!res.includes('> '));
        assert.ok(!res.includes('###'));
        assert.ok(res.includes('25-го.\nВажно:'));
    });

    it('cleanResponse не трогает почту, ссылки и одиночные звёздочки', () => {
        const input = 'Пишите на m.s.kurochkina@urfu.ru или смотрите rtf.urfu.ru/ru/kontakty/ (оценка 4* и выше).';
        assert.equal(cleanResponse(input), input);
    });

    it('cleanResponse сохраняет переводы строк в списках', () => {
        const res = cleanResponse('Порядок действий:\n1. Напишите заявление.\n2. Отнесите в деканат.');
        assert.ok(res.includes('\n1. Напишите'));
        assert.ok(res.includes('\n2. Отнесите'));
    });
});

// ═══════════════════════════════════════════════════════
// 9. ЛОГИРОВАНИЕ (Этап 5)
// ═══════════════════════════════════════════════════════

describe('logger — форматирование', () => {
    const { formatArg, splitTag, makeClock } = require('../logger')._test;

    // Регрессия: JSON.stringify не видит message у ошибки — в логах было «{}»
    it('Ошибка выводится текстом с кодом, а не «{}»', () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:5433');
        err.code = 'ECONNREFUSED';
        assert.equal(formatArg(err), 'connect ECONNREFUSED 127.0.0.1:5433 [ECONNREFUSED]');
    });

    // Регрессия: у AggregateError из pg пустой message — в логе было «: .»
    it('У AggregateError берётся текст вложенных ошибок', () => {
        const agg = new AggregateError([new Error('connect ECONNREFUSED ::1:5433'), new Error('connect ECONNREFUSED 127.0.0.1:5433')], '');
        agg.code = 'ECONNREFUSED';
        const text = formatArg(agg);
        assert.ok(text.includes('::1:5433') && text.includes('127.0.0.1:5433'), text);
    });

    it('Тег подсистемы отделяется и приводится к верхнему регистру', () => {
        assert.deepEqual(splitTag('[Worker] Взята задача 5'), { tag: 'WORKER', msg: 'Взята задача 5' });
        assert.deepEqual(splitTag('Сообщение без тега'), { tag: 'APP', msg: 'Сообщение без тега' });
    });

    // Регрессия: время писалось в UTC — 22:22 вместо местных 03:22 следующего дня
    it('Время — в заданном часовом поясе, включая переход через полночь', () => {
        const clock = makeClock('Asia/Yekaterinburg');
        const t = clock(new Date(Date.UTC(2026, 8, 14, 22, 22, 0)));
        assert.equal(t.stamp, '2026-09-15 03:22:00');
        assert.equal(t.day, '2026-09-15');
    });
});

describe('logger — буфер, файлы, хранение', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { createLogger } = require('../logger');

    const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bot-logs-'));
    const fixedNow = () => new Date(Date.UTC(2026, 8, 15, 10, 0, 0)); // 15.09.2026 15:00 по Екатеринбургу

    it('Записи ниже уровня отбрасываются', () => {
        const log = createLogger({ level: 'info' });
        log.debug('[FSM] подробность');
        log.info('[BOT] событие');
        assert.deepEqual(log.entries().map(e => e.tag), ['BOT']);
    });

    it('entries(since) отдаёт только новые записи — для догрузки на странице', () => {
        const log = createLogger({});
        const first = log.info('[A] раз');
        log.info('[B] два');
        log.warn('[C] три');
        assert.deepEqual(log.entries(first.id).map(e => e.tag), ['B', 'C']);
    });

    it('Буфер в памяти ограничен', () => {
        const log = createLogger({ bufferSize: 3 });
        for (let i = 1; i <= 5; i++) log.info(`[T] ${i}`);
        assert.deepEqual(log.entries().map(e => e.msg), ['3', '4', '5']);
    });

    it('Запись в файл за день, со стеком у ошибок', async () => {
        const dir = tmpDir();
        const log = createLogger({ dir, now: fixedNow });
        log.info('[SEARCH] Решение: ответ из базы');
        log.error('[DB] Ошибка запроса:', new Error('duplicate key'));
        await log.close();

        const text = fs.readFileSync(path.join(dir, 'app-2026-09-15.log'), 'utf8');
        assert.ok(text.includes('[2026-09-15 15:00:00] INFO  [SEARCH] Решение: ответ из базы'), text);
        assert.ok(text.includes('ERROR [DB] Ошибка запроса: duplicate key'));
        assert.ok(/\n\s+at /.test(text), 'в файле должен быть стек вызовов');
    });

    it('Файлы старше срока хранения удаляются, свежие остаются', async () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, 'app-2026-08-01.log'), 'старый');
        fs.writeFileSync(path.join(dir, 'app-2026-09-10.log'), 'свежий');
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'чужой файл');

        const log = createLogger({ dir, now: fixedNow, retentionDays: 14 });
        log.info('[APP] старт');
        await log.close();

        const files = fs.readdirSync(dir).sort();
        assert.deepEqual(files, ['app-2026-09-10.log', 'app-2026-09-15.log', 'notes.txt']);
        assert.deepEqual(log.files(), ['2026-09-15', '2026-09-10']);
    });

    it('Путь к файлу: только формат даты — выйти из папки логов нельзя', async () => {
        const dir = tmpDir();
        const log = createLogger({ dir, now: fixedNow });
        log.info('[APP] старт');
        await log.close();
        assert.ok(log.filePath('2026-09-15'));
        assert.equal(log.filePath('../../.env'), null);
        assert.equal(log.filePath('2026-09-15/../../x'), null);
        assert.equal(log.filePath('2020-01-01'), null); // файла нет
    });
});

describe('database — распознавание обрыва связи', () => {
    const { isConnectionError } = require('../database')._test;

    it('Обрыв и отказ соединения — это ошибки связи', () => {
        assert.ok(isConnectionError({ code: 'ECONNREFUSED', message: '' }));
        assert.ok(isConnectionError({ code: '57P01', message: 'terminating connection due to administrator command' }));
        assert.ok(isConnectionError({ code: '08006', message: 'connection failure' }));
        assert.ok(isConnectionError({ message: 'Connection terminated unexpectedly' }));
    });

    it('Ошибки самого запроса — не ошибки связи', () => {
        assert.ok(!isConnectionError({ code: '23505', message: 'duplicate key value' }));
        assert.ok(!isConnectionError({ code: '42P01', message: 'relation "x" does not exist' }));
    });
});

// ═══════════════════════════════════════════════════════
// 10. КУРС ПО НАЗВАНИЮ СООБЩЕСТВА (Этап 6)
// ═══════════════════════════════════════════════════════

describe('courses — разбор названий сообществ', () => {
    const { parseCommunityName, courseOfGroup, withCourse } = require('../courses');

    // Реальные названия сообществ, сентябрь 2026
    it('Все четыре настоящих названия', () => {
        assert.deepEqual(parseCommunityName('Первый курс ИРИТ-РТФ УрФУ'), { course: 1, archived: false });
        assert.deepEqual(parseCommunityName('Второй курс Бакалавриат ИРИТ УрФУ'), { course: 2, archived: false });
        assert.deepEqual(parseCommunityName('Третий курс ИОТ ИРИТ УрФУ'), { course: 3, archived: false });
        assert.deepEqual(parseCommunityName('Четвертый курс ИОТ ИРИТ-РТФ УрФУ'), { course: 4, archived: false });
    });

    it('Архив после выпуска распознаётся, хотя слово «Четвертый» в названии осталось', () => {
        assert.deepEqual(parseCommunityName('Четвертый курс ИОТ, УрФУ - Архив 25/26'), { course: 4, archived: true });
    });

    it('Год выпуска в названии архива на распознавание не влияет', () => {
        assert.equal(parseCommunityName('Четвертый курс ИОТ, УрФУ - Архив 26/27').archived, true);
        assert.equal(parseCommunityName('Четвертый курс ИОТ, УрФУ - Архив 31/32').archived, true);
    });

    it('«Четвёртый» через ё и курс цифрой', () => {
        assert.equal(parseCommunityName('Четвёртый курс ИОТ').course, 4);
        assert.equal(parseCommunityName('2 курс ИОТ').course, 2);
        assert.equal(parseCommunityName('2-й курс ИОТ').course, 2);
    });

    it('Названия без курса — курс не определён', () => {
        assert.equal(parseCommunityName('bot-IOT-test').course, null);
        assert.equal(parseCommunityName('Курс молодого бойца').course, null);
        assert.equal(parseCommunityName('Пятый курс').course, null); // бакалавриат — 4 года
    });

    it('Курс из номера группы и замена курса', () => {
        assert.equal(courseOfGroup('РИ-240944'), 2);
        assert.equal(courseOfGroup('ерунда'), null);
        assert.equal(withCourse('РИ-140944', 2), 'РИ-240944');
        assert.equal(withCourse('РИ-240944', 2), 'РИ-240944'); // повтор ничего не ломает
    });
});

describe('group_sync — что делать при смене названия', () => {
    const { decideAction } = require('../group_sync')._test;
    const s = (course, archived = false) => ({ course, archived });

    it('Курс вырос на единицу — перевод', () => assert.equal(decideAction(s(2), s(3)), 'promote'));
    it('Ушло в архив — выпуск', () => assert.equal(decideAction(s(4), s(4, true)), 'graduate'));
    it('Сменилось только название — ничего', () => assert.equal(decideAction(s(2), s(2)), 'none'));
    it('Курс определён впервые — ничего, это точка отсчёта', () => assert.equal(decideAction(s(null), s(2)), 'none'));
    it('Курс назад или через курс — студентов не трогаем', () => {
        assert.equal(decideAction(s(3), s(1)), 'anomaly');
        assert.equal(decideAction(s(1), s(3)), 'anomaly');
    });
    it('Повторная сверка архива — ничего', () => assert.equal(decideAction(s(4, true), s(4, true)), 'none'));
    it('Архив снова стал курсовым сообществом — новая точка отсчёта', () => assert.equal(decideAction(s(4, true), s(1)), 'reopen'));
});

describe('group_sync — перевод студентов в базе', () => {
    const { syncGroup } = require('../group_sync');
    const G = 999000001;       // сообщество, которое переименуют
    const OTHER = 999000002;   // чужое сообщество
    const ids = [99999980, 99999981, 99999982, 99999983, 99999984];

    const nameIs = (name) => async () => name;
    const group = async () => (await db.query('SELECT * FROM vk_groups WHERE group_id = $1', [G])).rows[0];
    const userGroup = async (vkId) => (await db.query('SELECT group_number, is_graduated FROM users WHERE vk_id = $1', [vkId])).rows[0];

    async function setup(name, course, archived = false) {
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [ids]);
        await db.query('DELETE FROM vk_groups WHERE group_id = ANY($1)', [[G, OTHER]]);
        await db.query("INSERT INTO vk_groups (group_id, group_name, access_token, course, is_archived) VALUES ($1, $2, 'test', $3, $4)", [G, name, course, archived]);
        await db.query(`INSERT INTO users (vk_id, role, group_number, vk_group_id, is_graduated, state) VALUES
            ($1, 'student',  'РИ-240944', $6, FALSE, 'main_menu'),  -- обычный студент потока
            ($2, 'student',  'РИ-340944', $6, FALSE, 'main_menu'),  -- уже указал новый курс
            ($3, 'student',  'РИ-240944', $7, FALSE, 'main_menu'),  -- из другого сообщества
            ($4, 'operator', 'РИ-240944', $6, FALSE, 'main_menu'),  -- администратор
            ($5, 'student',  'РИ-240944', $6, TRUE,  'main_menu')   -- уже выпускник`,
            [...ids, G, OTHER]);
    }

    after(async () => {
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [ids]);
        await db.query('DELETE FROM vk_groups WHERE group_id = ANY($1)', [[G, OTHER]]);
    });

    it('Переименование «Второй» → «Третий» переводит только студентов этого сообщества', async () => {
        await setup('Второй курс ИОТ ИРИТ УрФУ', 2);
        const r = await syncGroup(await group(), { fetchName: nameIs('Третий курс ИОТ ИРИТ УрФУ') });

        assert.equal(r.action, 'promote');
        assert.equal(r.changed, 1, 'переведён должен быть ровно один — обычный студент потока');
        assert.equal((await userGroup(ids[0])).group_number, 'РИ-340944');
        assert.equal((await userGroup(ids[1])).group_number, 'РИ-340944'); // не уехал на 4 курс
        assert.equal((await userGroup(ids[2])).group_number, 'РИ-240944'); // чужое сообщество
        assert.equal((await userGroup(ids[3])).group_number, 'РИ-240944'); // администратор
        assert.equal((await userGroup(ids[4])).group_number, 'РИ-240944'); // выпускник

        const g = await group();
        assert.equal(g.course, 3);
        assert.equal(g.group_name, 'Третий курс ИОТ ИРИТ УрФУ');
        assert.ok(g.name_synced_at);
    });

    it('Повторная сверка того же названия ничего не меняет', async () => {
        const r = await syncGroup(await group(), { fetchName: nameIs('Третий курс ИОТ ИРИТ УрФУ') });
        assert.equal(r.action, 'none');
        assert.equal((await userGroup(ids[0])).group_number, 'РИ-340944');
    });

    it('Уход в архив выпускает студентов сообщества', async () => {
        await setup('Четвертый курс ИОТ ИРИТ-РТФ УрФУ', 4);
        const r = await syncGroup(await group(), { fetchName: nameIs('Четвертый курс ИОТ, УрФУ - Архив 25/26') });
        assert.equal(r.action, 'graduate');
        assert.equal((await userGroup(ids[0])).is_graduated, true);
        assert.equal((await userGroup(ids[2])).is_graduated, false); // чужое сообщество
        assert.equal((await group()).is_archived, true);
    });

    it('Смена только названия (как с «Бакалавриат») — название обновлено, студенты на месте', async () => {
        await setup('Второй курс ИРИТ УрФУ', 2);
        const r = await syncGroup(await group(), { fetchName: nameIs('Второй курс Бакалавриат ИРИТ УрФУ') });
        assert.equal(r.action, 'none');
        assert.equal((await group()).group_name, 'Второй курс Бакалавриат ИРИТ УрФУ');
        assert.equal((await userGroup(ids[0])).group_number, 'РИ-240944');
    });

    it('Необычная смена курса (3 → 1) — студенты не тронуты, курс сообщества прежний', async () => {
        await setup('Третий курс ИОТ ИРИТ УрФУ', 3);
        const r = await syncGroup(await group(), { fetchName: nameIs('Первый курс ИРИТ-РТФ УрФУ') });
        assert.equal(r.action, 'anomaly');
        assert.equal((await userGroup(ids[0])).group_number, 'РИ-240944');
        // Регрессия: иначе проверка при сообщениях «исправила» бы студентов на 1 курс
        assert.equal((await group()).course, 3);
        assert.equal((await group()).group_name, 'Первый курс ИРИТ-РТФ УрФУ');
    });
});

describe('bot — сверка курса студента при сообщении', () => {
    const { reconcileStudentCourse, checkGroupAgainstCommunity } = require('../bot')._test;
    const G2 = 999000011;   // сообщество 2 курса
    const TEST = 999000012; // сообщество без курса (как тестовое)
    const STUDENT = 99999990;

    const sent = [];
    const ctx = { send: async (m) => { sent.push(m); } };

    before(async () => {
        await db.query('DELETE FROM vk_groups WHERE group_id = ANY($1)', [[G2, TEST]]);
        await db.query("INSERT INTO vk_groups (group_id, group_name, access_token, course) VALUES ($1, 'Второй курс ИОТ', 't', 2), ($2, 'bot-IOT-test', 't', NULL)", [G2, TEST]);
    });
    after(async () => {
        await db.query('DELETE FROM users WHERE vk_id = $1', [STUDENT]);
        await db.query('DELETE FROM vk_groups WHERE group_id = ANY($1)', [[G2, TEST]]);
    });
    const makeStudent = async (groupNumber, vkGroupId = null) => {
        await db.query('DELETE FROM users WHERE vk_id = $1', [STUDENT]);
        await db.query("INSERT INTO users (vk_id, role, group_number, vk_group_id, state) VALUES ($1, 'student', $2, $3, 'main_menu')", [STUDENT, groupNumber, vkGroupId]);
        return (await db.query('SELECT * FROM users WHERE vk_id = $1', [STUDENT])).rows[0];
    };

    // Регрессия: студентов не перевели летом 2026 (cron не был подключён)
    it('Устаревший номер группы исправляется по сообществу, студенту приходит пояснение', async () => {
        sent.length = 0;
        // Сообщество к моменту сверки уже записано: этим занимается handleMessage
        // при первом же сообщении, см. «Сообщество запоминается и у тех, кто ещё
        // не выбрал роль»
        const user = await makeStudent('РИ-140944', G2);
        const updated = await reconcileStudentCourse(ctx, user, G2);

        assert.equal(updated.group_number, 'РИ-240944');
        const row = (await db.query('SELECT group_number FROM users WHERE vk_id = $1', [STUDENT])).rows[0];
        assert.equal(row.group_number, 'РИ-240944');
        assert.equal(sent.length, 1);
        assert.ok(String(sent[0]).includes('РИ-140944 → РИ-240944'));
    });

    it('Сообщение из чужого сообщества данные не меняет', async () => {
        sent.length = 0;
        const user = await makeStudent('РИ-340944', TEST);
        const updated = await reconcileStudentCourse(ctx, user, G2);
        assert.equal(updated.group_number, 'РИ-340944');
        assert.equal(sent.length, 0);
    });

    it('В сообществе без курса ничего не исправляется', async () => {
        sent.length = 0;
        const user = await makeStudent('РИ-140944', null);
        const updated = await reconcileStudentCourse(ctx, user, TEST);
        assert.equal(updated.group_number, 'РИ-140944');
        assert.equal(sent.length, 0);
    });

    it('Проверка при регистрации: номер группы против курса сообщества', async () => {
        assert.equal(await checkGroupAgainstCommunity('РИ-240944', G2), null);
        const refusal = await checkGroupAgainstCommunity('РИ-340944', G2);
        assert.ok(refusal && refusal.includes('2 курса') && refusal.includes('3 курс'), refusal);
        assert.equal(await checkGroupAgainstCommunity('РИ-340944', TEST), null); // курс неизвестен — не проверяем
    });
});

// ═══════════════════════════════════════════════════════
// 11. ГИГИЕНА (Этап 7)
// ═══════════════════════════════════════════════════════

describe('bot — ограничение подбора кода администратора', () => {
    const { codeLockRemaining, registerCodeFailure, codeAttempts } = require('../bot')._test;
    const ATTACKER = 'test-attacker';

    it('Четыре ошибки — ещё можно пробовать, пятая — блокировка на 15 минут', () => {
        codeAttempts.delete(ATTACKER);
        for (let i = 1; i <= 4; i++) {
            assert.equal(registerCodeFailure(ATTACKER), i);
            assert.equal(codeLockRemaining(ATTACKER), 0, `после ${i} ошибок блокировки быть не должно`);
        }
        registerCodeFailure(ATTACKER);
        const lock = codeLockRemaining(ATTACKER);
        assert.ok(lock > 14 * 60 * 1000 && lock <= 15 * 60 * 1000, `ожидали ~15 минут, получили ${lock} мс`);
    });

    it('По истечении окна счётчик сбрасывается', () => {
        codeAttempts.set(ATTACKER, { count: 5, firstAt: Date.now() - 16 * 60 * 1000 });
        assert.equal(codeLockRemaining(ATTACKER), 0);
        assert.equal(registerCodeFailure(ATTACKER), 1);
        codeAttempts.delete(ATTACKER);
    });

    it('Блокировка у одного пользователя не мешает другим', () => {
        for (let i = 0; i < 5; i++) registerCodeFailure(ATTACKER);
        assert.ok(codeLockRemaining(ATTACKER) > 0);
        assert.equal(codeLockRemaining('someone-else'), 0);
        codeAttempts.delete(ATTACKER);
    });
});

// ═══════════════════════════════════════════════════════
// 12. ДЛИННЫЕ ВОПРОСЫ И ПЕРЕХОД К АДМИНИСТРАТОРУ
// ═══════════════════════════════════════════════════════

describe('bot — длинный вопрос и очередь ИИ', () => {
    const { enqueueAiTask, handleMessage, AI_QUESTION_MAX_LENGTH, LONG_WAIT_SECONDS } = require('../bot')._test;
    const STUDENT = 99999991;
    const GROUP = 999000013;
    const OPERATOR = 99999992;

    const sent = [];
    const ctx = (over = {}) => ({
        senderId: STUDENT,
        attachments: [],
        send: async (m) => { sent.push(m); return 1; },
        ...over
    });
    // Заглушка VK: уведомления администраторам никуда не уходят
    const vk = { api: { messages: { send: async () => 1 } } };

    const student = async () => {
        await db.query('DELETE FROM users WHERE vk_id = $1', [STUDENT]);
        await db.query(
            "INSERT INTO users (vk_id, role, full_name, group_number, state) VALUES ($1, 'student', 'Тестов Тест', 'РИ-240944', 'ask_question_mode')",
            [STUDENT]
        );
        return (await db.query('SELECT * FROM users WHERE vk_id = $1', [STUDENT])).rows[0];
    };
    const queueSize = async () => Number((await db.query('SELECT count(*) FROM ai_queue WHERE vk_id = $1', [STUDENT])).rows[0].count);
    const keyboardText = (message) => JSON.stringify(message.keyboard || {});

    before(async () => {
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[STUDENT, OPERATOR]]);
        await db.query("INSERT INTO users (vk_id, role, full_name, state) VALUES ($1, 'operator', 'Админ Тестовый', 'main_menu')", [OPERATOR]);
    });
    after(async () => {
        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [STUDENT]);
        await db.query('DELETE FROM tickets WHERE student_vk_id = $1', [STUDENT]);
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[STUDENT, OPERATOR]]);
    });
    beforeEach(async () => {
        sent.length = 0;
        await db.query('DELETE FROM ai_queue');
    });

    it('Короткий вопрос уходит в очередь ИИ, лишних кнопок нет', async () => {
        const user = await student();
        await enqueueAiTask(ctx(), user, 'Когда стипендия?', '', GROUP);

        assert.equal(await queueSize(), 1);
        assert.equal(sent.length, 1);
        assert.ok(!keyboardText(sent[0]).includes('администратору'), 'при пустой очереди кнопка администратора не нужна');
    });

    // Вопрос на тысячу с лишним символов модель всё равно не осилит:
    // в базе знаний таких формулировок нет, и она начинает додумывать
    it('Длинный вопрос в очередь не ставится — предлагается администратор', async () => {
        const user = await student();
        const long = 'Здравствуйте, у меня вопрос по пересдаче. '.repeat(30);
        assert.ok(long.length > AI_QUESTION_MAX_LENGTH);

        await enqueueAiTask(ctx(), user, long, '', GROUP);

        assert.equal(await queueSize(), 0, 'ИИ такой вопрос не получает');
        assert.equal(sent.length, 1);
        assert.ok(keyboardText(sent[0]).includes('Передать администратору'));
    });

    it('Текст длинного вопроса сохраняется: кнопка создаёт заявку с ним, а не с заглушкой', async () => {
        const user = await student();
        const long = 'Не могу разобраться с баллами за курс VK Education. '.repeat(25);
        await enqueueAiTask(ctx(), user, long, '', GROUP);

        await handleMessage(ctx({ text: null, messagePayload: { command: 'operator_request' } }), vk, GROUP);

        const ticket = (await db.query('SELECT question FROM tickets WHERE student_vk_id = $1 ORDER BY id DESC LIMIT 1', [STUDENT])).rows[0];
        assert.ok(ticket, 'заявка должна создаться');
        assert.ok(ticket.question.startsWith('Не могу разобраться с баллами'), ticket.question.slice(0, 60));
    });

    it('При длинной очереди рядом с ожиданием появляется кнопка администратора', async () => {
        const user = await student();
        // Столько задач, что расчётное ожидание заведомо больше порога
        for (let i = 0; i < 30; i++) {
            await db.query("INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context) VALUES ($1, $2, '[]', '')", [OPERATOR, GROUP]);
        }

        await enqueueAiTask(ctx(), user, 'Где посмотреть расписание?', '', GROUP);

        assert.equal(await queueSize(), 1, 'вопрос всё равно ставится в очередь');
        assert.equal(sent.length, 1);
        assert.ok(String(sent[0].message).includes('Ждать долго'), sent[0].message);
        assert.ok(keyboardText(sent[0]).includes('Передать администратору'));
        await db.query('DELETE FROM ai_queue WHERE vk_id = $1', [OPERATOR]);
    });

    // Регрессия: задача оставалась в очереди, и студент получал ответ ИИ
    // уже после того, как передал вопрос администратору
    it('Переход к администратору снимает вопрос с очереди ИИ', async () => {
        const user = await student();
        await enqueueAiTask(ctx(), user, 'Как попасть в общежитие?', '', GROUP);
        assert.equal(await queueSize(), 1);

        await handleMessage(ctx({ text: null, messagePayload: { command: 'operator_request' } }), vk, GROUP);

        assert.equal(await queueSize(), 0, 'задача ИИ должна быть снята');
    });

    it('Порог ожидания задан в секундах и разумен', () => {
        assert.ok(LONG_WAIT_SECONDS >= 60 && LONG_WAIT_SECONDS <= 600);
    });
});

describe('bot — завершение диалога', () => {
    const { handleMessage } = require('../bot')._test;
    const STUDENT = 99999993;
    const OPERATOR = 99999994;
    const GROUP = 999000014;

    // Заглушка VK: запоминаем, что ушло собеседнику
    const notified = [];
    const vk = { api: { messages: { send: async (params) => { notified.push(params); return 1; } } } };
    const ctx = (senderId) => ({ senderId, text: '🏁 Завершить этот тикет', attachments: [], send: async () => 1 });

    let ticketId;
    const openDialog = async () => {
        await db.query('DELETE FROM tickets WHERE student_vk_id = $1', [STUDENT]);
        const t = await db.query(
            "INSERT INTO tickets (student_vk_id, operator_vk_id, question, status) VALUES ($1, $2, 'Вопрос', 'active') RETURNING id",
            [STUDENT, OPERATOR]
        );
        ticketId = t.rows[0].id;
        await db.query("UPDATE users SET state = 'chat_mode', current_chat_ticket_id = $1 WHERE vk_id = ANY($2)", [ticketId, [STUDENT, OPERATOR]]);
        notified.length = 0;
    };

    before(async () => {
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[STUDENT, OPERATOR]]);
        await db.query("INSERT INTO users (vk_id, role, full_name, state) VALUES ($1, 'student', 'Тестов Тест', 'main_menu'), ($2, 'operator', 'Админ Тестовый', 'main_menu')", [STUDENT, OPERATOR]);
    });
    after(async () => {
        await db.query('DELETE FROM tickets WHERE student_vk_id = $1', [STUDENT]);
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[STUDENT, OPERATOR]]);
    });

    it('Студенту сообщают, что диалог завершил администратор', async () => {
        await openDialog();
        await handleMessage(ctx(OPERATOR), vk, GROUP);

        assert.equal(notified.length, 1);
        assert.equal(String(notified[0].peer_id), String(STUDENT));
        assert.ok(notified[0].message.includes('Администратор завершил диалог'), notified[0].message);
        assert.ok(notified[0].message.includes(`#${ticketId}`));
    });

    it('Администратору сообщают, что диалог завершил студент', async () => {
        await openDialog();
        await handleMessage(ctx(STUDENT), vk, GROUP);

        assert.equal(notified.length, 1);
        assert.equal(String(notified[0].peer_id), String(OPERATOR));
        assert.ok(notified[0].message.includes('Студент завершил диалог'), notified[0].message);
    });
});

describe('bot — уведомления администраторов', () => {
    const { handleMessage } = require('../bot')._test;
    const STUDENT = 99999995;
    const ALENA = 99999996;   // уведомления включены
    const IVAN = 99999997;    // уведомления включены
    const MOLCHUN = 99999998; // уведомления выключены
    const GROUP = 999000015;

    const sent = [];
    const vk = { api: { messages: { send: async (params) => { sent.push(params); return 1; } } } };
    const ctx = (senderId, over = {}) => ({ senderId, text: null, attachments: [], send: async () => 1, ...over });
    const to = (vkId) => sent.filter(m => String(m.peer_id) === String(vkId));
    const lastTicket = async () => (await db.query('SELECT * FROM tickets WHERE student_vk_id = $1 ORDER BY id DESC LIMIT 1', [STUDENT])).rows[0];

    before(async () => {
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[STUDENT, ALENA, IVAN, MOLCHUN]]);
        await db.query("INSERT INTO users (vk_id, role, full_name, group_number, state) VALUES ($1, 'student', 'Тестов Тест', 'РИ-240944', 'main_menu')", [STUDENT]);
        await db.query("INSERT INTO users (vk_id, role, full_name, state, notify_tickets) VALUES ($1, 'operator', 'Алёна', 'main_menu', TRUE), ($2, 'operator', 'Иван', 'main_menu', TRUE), ($3, 'operator', 'Молчун', 'main_menu', FALSE)", [ALENA, IVAN, MOLCHUN]);
    });
    after(async () => {
        await db.query('DELETE FROM tickets WHERE student_vk_id = $1', [STUDENT]);
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[STUDENT, ALENA, IVAN, MOLCHUN]]);
    });
    beforeEach(() => { sent.length = 0; });

    it('Новый вопрос приходит только тем, у кого уведомления включены', async () => {
        await handleMessage(ctx(STUDENT, { messagePayload: { command: 'confirm_send', question: 'Когда пересдача?' } }), vk, GROUP);

        assert.equal(to(ALENA).length, 1);
        assert.equal(to(IVAN).length, 1);
        assert.equal(to(MOLCHUN).length, 0, 'администратор отключил уведомления');
    });

    it('Когда вопрос берут в работу, студент и остальные видят имя администратора', async () => {
        const ticket = await lastTicket();
        await handleMessage(ctx(ALENA, { messagePayload: { command: 'take_ticket', ticket_id: ticket.id } }), vk, GROUP);

        const student = to(STUDENT)[0];
        assert.ok(student && student.message.includes('Администратор: Алёна'), student && student.message);
        const ivan = to(IVAN)[0];
        assert.ok(ivan && ivan.message.includes(`#${ticket.id}`) && ivan.message.includes('Алёна'), ivan && ivan.message);
        assert.equal(to(MOLCHUN).length, 0);
        assert.equal(to(ALENA).length, 0, 'взявшему уведомление ни к чему');
    });

    // Регрессия: проверка статуса и запись шли двумя запросами — при
    // одновременном нажатии вопрос доставался обоим
    it('Второй администратор получает отказ, вопрос остаётся у первого', async () => {
        const ticket = await lastTicket();
        const answers = [];
        await handleMessage(ctx(IVAN, { messagePayload: { command: 'take_ticket', ticket_id: ticket.id }, send: async (m) => { answers.push(m); return 1; } }), vk, GROUP);

        assert.ok(String(answers[0]).includes('уже взял'), String(answers[0]));
        const row = (await db.query('SELECT operator_vk_id FROM tickets WHERE id = $1', [ticket.id])).rows[0];
        assert.equal(String(row.operator_vk_id), String(ALENA));
    });

    it('Переключатель в профиле выключает и включает уведомления', async () => {
        const state = async () => (await db.query('SELECT notify_tickets FROM users WHERE vk_id = $1', [ALENA])).rows[0].notify_tickets;
        const shown = [];
        const profileCtx = () => ctx(ALENA, { messagePayload: { command: 'toggle_notify' }, send: async (m) => { shown.push(m); return 1; } });

        await handleMessage(profileCtx(), vk, GROUP);
        assert.equal(await state(), false);
        assert.ok(shown[0].message.includes('выключены'), shown[0].message);

        await handleMessage(profileCtx(), vk, GROUP);
        assert.equal(await state(), true);
        assert.ok(shown[1].message.includes('включены'), shown[1].message);
    });

    it('Чужой не может переключить уведомления кнопкой', async () => {
        const answers = [];
        await handleMessage(ctx(STUDENT, { messagePayload: { command: 'toggle_notify' }, send: async (m) => { answers.push(m); return 1; } }), vk, GROUP);
        assert.ok(String(answers[0]).includes('только администраторам'), String(answers[0]));
    });
});

// ═══════════════════════════════════════════════════════
// 13. ПЕРЕНОС ДИАЛОГА В БАЗУ ЗНАНИЙ
// ═══════════════════════════════════════════════════════

describe('ai_service — разбор ответа модели', () => {
    const { parseDraftJson } = require('../ai_service')._test;

    it('JSON достаётся из ответа, даже если модель обернула его в текст', () => {
        const draft = parseDraftJson('Вот запись:\n```json\n{"category":"Учёба","question":"Где взять справку?","answer":"В деканате, каб. Р-219.","keywords":"справка, деканат"}\n```');
        assert.equal(draft.category, 'Учёба');
        assert.equal(draft.question, 'Где взять справку?');
        assert.equal(draft.keywords, 'справка, деканат');
    });

    it('Пустая категория заменяется, пустой вопрос — ошибка', () => {
        const draft = parseDraftJson('{"category":"","question":"Вопрос","answer":"Ответ","keywords":""}');
        assert.equal(draft.category, 'Без категории');
        assert.throws(() => parseDraftJson('{"category":"Учёба","question":"","answer":"Ответ"}'));
        assert.throws(() => parseDraftJson('модель ответила текстом без json'));
    });
});

describe('bot — запись в базу знаний из диалога', () => {
    const bot = require('../bot');
    const { handleMessage, buildDialogText } = bot._test;
    const aiService = require('../ai_service');
    const STUDENT = 99999981;
    const ADMIN = 99999982;
    const OTHER_ADMIN = 99999983;
    const GROUP = 999000016;

    const sent = [];
    const vk = { api: { messages: { send: async () => 1 } } };
    const ctx = (senderId, payload) => ({
        senderId, text: null, attachments: [], messagePayload: payload,
        send: async (m) => { sent.push(m); return 1; }
    });
    const lastMessage = () => sent[sent.length - 1];
    const keyboardOf = (m) => JSON.stringify((m && m.keyboard) || {});

    let ticketId;
    const realDraft = aiService.draftFaqFromDialog;

    before(async () => {
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[STUDENT, ADMIN, OTHER_ADMIN]]);
        await db.query(
            `INSERT INTO users (vk_id, role, full_name, group_number, state) VALUES
                ($1, 'student', 'Тестов Тест', 'РИ-240944', 'main_menu'),
                ($2, 'operator', 'Алёна', NULL, 'main_menu'),
                ($3, 'operator', 'Иван', NULL, 'main_menu')`,
            [STUDENT, ADMIN, OTHER_ADMIN]
        );

        const t = await db.query(
            "INSERT INTO tickets (student_vk_id, operator_vk_id, question, status) VALUES ($1, $2, 'Где получить справку об обучении?', 'closed') RETURNING id",
            [STUDENT, ADMIN]
        );
        ticketId = t.rows[0].id;
        await db.query(
            "INSERT INTO messages (ticket_id, sender_vk_id, text) VALUES ($1, $2, 'Здравствуйте, мне нужна справка'), ($1, $3, 'Подойдите в деканат, аудитория Р-219'), ($1, $2, 'Спасибо!')",
            [ticketId, STUDENT, ADMIN]
        );
    });

    after(async () => {
        aiService.draftFaqFromDialog = realDraft;
        await db.query('DELETE FROM faq WHERE category = $1', ['Тестовая категория']);
        await db.query('DELETE FROM messages WHERE ticket_id = $1', [ticketId]);
        await db.query('DELETE FROM tickets WHERE student_vk_id = $1', [STUDENT]);
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[STUDENT, ADMIN, OTHER_ADMIN]]);
    });

    beforeEach(async () => {
        sent.length = 0;
        aiService.draftFaqFromDialog = async () => ({
            category: 'Тестовая категория',
            question: 'Где получить справку об обучении?',
            answer: 'Нужно подойти в деканат, аудитория Р-219.',
            keywords: 'справка, деканат'
        });
        await db.query('UPDATE users SET faq_draft = NULL WHERE vk_id = ANY($1)', [[ADMIN, OTHER_ADMIN]]);
        await db.query('DELETE FROM faq WHERE category = $1', ['Тестовая категория']);
    });

    it('Переписка собирается с указанием, кто что сказал', async () => {
        const ticket = (await db.query('SELECT * FROM tickets WHERE id = $1', [ticketId])).rows[0];
        const text = await buildDialogText(ticket);

        assert.ok(text.startsWith('Вопрос студента: Где получить справку'), text);
        assert.ok(text.includes('Студент: Здравствуйте, мне нужна справка'));
        assert.ok(text.includes('Администратор: Подойдите в деканат, аудитория Р-219'));
    });

    it('Черновик показывается администратору и в базу знаний пока не пишется', async () => {
        await handleMessage(ctx(ADMIN, { command: 'faq_draft', ticket_id: ticketId }), vk, GROUP);

        const preview = lastMessage();
        assert.ok(String(preview.message).includes('Черновик записи'), preview.message);
        assert.ok(String(preview.message).includes('Нужно подойти в деканат'));
        assert.ok(keyboardOf(preview).includes('Сохранить'));

        const faq = await db.query("SELECT count(*) FROM faq WHERE category = 'Тестовая категория'");
        assert.equal(Number(faq.rows[0].count), 0, 'до подтверждения записи быть не должно');

        const draft = (await db.query('SELECT faq_draft FROM users WHERE vk_id = $1', [ADMIN])).rows[0].faq_draft;
        assert.equal(draft.ticket_id, ticketId);
    });

    it('После подтверждения запись появляется в базе знаний, черновик очищается', async () => {
        await handleMessage(ctx(ADMIN, { command: 'faq_draft', ticket_id: ticketId }), vk, GROUP);
        await handleMessage(ctx(ADMIN, { command: 'faq_save' }), vk, GROUP);

        const row = (await db.query("SELECT * FROM faq WHERE category = 'Тестовая категория'")).rows[0];
        assert.ok(row, 'запись должна появиться');
        assert.equal(row.question, 'Где получить справку об обучении?');
        assert.equal(row.keywords, 'справка, деканат');
        assert.ok(String(lastMessage()).includes('Добавлено в базу знаний'), String(lastMessage()));

        const draft = (await db.query('SELECT faq_draft FROM users WHERE vk_id = $1', [ADMIN])).rows[0].faq_draft;
        assert.equal(draft, null);
    });

    it('Отказ от черновика ничего не сохраняет', async () => {
        await handleMessage(ctx(ADMIN, { command: 'faq_draft', ticket_id: ticketId }), vk, GROUP);
        await handleMessage(ctx(ADMIN, { command: 'faq_cancel' }), vk, GROUP);

        const faq = await db.query("SELECT count(*) FROM faq WHERE category = 'Тестовая категория'");
        assert.equal(Number(faq.rows[0].count), 0);
        const draft = (await db.query('SELECT faq_draft FROM users WHERE vk_id = $1', [ADMIN])).rows[0].faq_draft;
        assert.equal(draft, null);
    });

    it('Чужой диалог разобрать нельзя', async () => {
        await handleMessage(ctx(OTHER_ADMIN, { command: 'faq_draft', ticket_id: ticketId }), vk, GROUP);

        assert.ok(String(lastMessage()).includes('вели не вы'), String(lastMessage()));
        const draft = (await db.query('SELECT faq_draft FROM users WHERE vk_id = $1', [OTHER_ADMIN])).rows[0].faq_draft;
        assert.equal(draft, null);
    });

    it('Студент не может дёрнуть кнопку подделанным payload', async () => {
        await handleMessage(ctx(STUDENT, { command: 'faq_save' }), vk, GROUP);
        assert.ok(String(lastMessage()).includes('только администраторам'), String(lastMessage()));
    });

    // Регрессия: при недоступном ИИ администратор не должен остаться без объяснения
    it('Если ИИ недоступен — понятное сообщение и кнопка повтора', async () => {
        aiService.draftFaqFromDialog = async () => { throw new Error('GigaChat API error 500'); };

        await handleMessage(ctx(ADMIN, { command: 'faq_draft', ticket_id: ticketId }), vk, GROUP);

        const msg = lastMessage();
        assert.ok(String(msg.message).includes('ИИ сейчас недоступен'), String(msg.message));
        assert.ok(keyboardOf(msg).includes('Попробовать ещё раз'));
        const draft = (await db.query('SELECT faq_draft FROM users WHERE vk_id = $1', [ADMIN])).rows[0].faq_draft;
        assert.equal(draft, null, 'черновика после сбоя быть не должно');
    });

    it('Кнопка сохранения без черновика не падает', async () => {
        await handleMessage(ctx(ADMIN, { command: 'faq_save' }), vk, GROUP);
        assert.ok(String(lastMessage()).includes('Черновик не найден'), String(lastMessage()));
    });
});

describe('bot — текст вопроса доходит до администратора', () => {
    const { handleMessage } = require('../bot')._test;
    const STUDENT = 99999961;
    const ADMIN = 99999962;
    const GROUP = 999000018;

    const sent = [];
    const notified = [];
    const vk = { api: { messages: { send: async (p) => { notified.push(p); return 1; } } } };
    const ctx = (senderId, over = {}) => ({
        senderId, text: null, attachments: [], messagePayload: null,
        send: async (m) => { sent.push(m); return 1; }, ...over
    });
    // Длиннее лимита payload у ВКонтакте (255 символов)
    const LONG = 'Здравствуйте! Подскажите, пожалуйста, как перевестись на другое направление внутри института: ' +
        'какие документы нужны, до какого числа подавать заявление, теряется ли при этом бюджетное место ' +
        'и что будет с академической разницей по предметам за первый курс? Заранее спасибо за ответ.';

    const payloadsOf = (m) => [...JSON.stringify((m && m.keyboard) || {}).matchAll(/"payload":"([^"]*)"/g)].map(x => x[1]);

    before(async () => {
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[STUDENT, ADMIN]]);
        await db.query(`INSERT INTO users (vk_id, role, full_name, group_number, state) VALUES
            ($1, 'student', 'Кузнецова Мария', 'РИ-240944', 'ask_question_mode'),
            ($2, 'operator', 'Алёна', NULL, 'main_menu')`, [STUDENT, ADMIN]);
        assert.ok(LONG.length > 255, 'вопрос должен быть длиннее лимита payload');
    });
    after(async () => {
        await db.query('DELETE FROM tickets WHERE student_vk_id = $1', [STUDENT]);
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[STUDENT, ADMIN]]);
    });
    beforeEach(async () => {
        sent.length = 0;
        notified.length = 0;
        await db.query('DELETE FROM tickets WHERE student_vk_id = $1', [STUDENT]);
        await db.query("UPDATE users SET state = 'ask_question_mode', pending_question = NULL, pending_attachments = NULL WHERE vk_id = $1", [STUDENT]);
    });

    // Регрессия: текст вопроса клали в payload кнопки, где у ВКонтакте лимит
    // 255 символов — на длинном вопросе сообщение с кнопками не отправлялось
    it('Кнопки под ответом не несут текст вопроса, каким бы длинным он ни был', async () => {
        await handleMessage(ctx(STUDENT, { text: LONG }), vk, GROUP);

        const withButtons = sent.filter(m => m && m.keyboard);
        assert.ok(withButtons.length > 0, 'бот должен предложить варианты');
        for (const message of withButtons) {
            for (const payload of payloadsOf(message)) {
                assert.ok(payload.length <= 255, `payload ${payload.length} символов: ${payload.slice(0, 80)}`);
                assert.ok(!payload.includes('перевестись'), 'текста вопроса в кнопке быть не должно');
            }
        }
    });

    it('Полный текст длинного вопроса доходит до обращения и до администраторов', async () => {
        await handleMessage(ctx(STUDENT, { text: LONG }), vk, GROUP);
        await handleMessage(ctx(STUDENT, { messagePayload: { command: 'confirm_send' } }), vk, GROUP);

        const ticket = (await db.query('SELECT * FROM tickets WHERE student_vk_id = $1', [STUDENT])).rows[0];
        assert.ok(ticket, 'обращение должно создаться');
        assert.equal(ticket.question, LONG, 'в обращении должен быть весь текст');

        const toAdmin = notified.find(n => String(n.peer_id) === String(ADMIN));
        assert.ok(toAdmin && toAdmin.message.includes('академической разницей'), 'администратор получает вопрос целиком');
    });

    // Раньше администратор видел только «Вы взяли тикет #N» и должен был
    // искать сам вопрос выше по переписке
    it('При взятии обращения администратор видит вопрос и кто его задал', async () => {
        await handleMessage(ctx(STUDENT, { text: LONG }), vk, GROUP);
        await handleMessage(ctx(STUDENT, { messagePayload: { command: 'confirm_send' } }), vk, GROUP);
        const ticket = (await db.query('SELECT * FROM tickets WHERE student_vk_id = $1', [STUDENT])).rows[0];

        sent.length = 0;
        await handleMessage(ctx(ADMIN, { messagePayload: { command: 'take_ticket', ticket_id: ticket.id } }), vk, GROUP);

        const shown = sent.map(m => (typeof m === 'string' ? m : m.message)).join('\n');
        assert.ok(shown.includes('Кузнецова Мария'), shown.slice(0, 120));
        assert.ok(shown.includes('РИ-240944'));
        assert.ok(shown.includes('академической разницей'), 'вопрос должен быть показан целиком');
    });

    it('Фото из вопроса приходят администратору при взятии обращения', async () => {
        await db.query("UPDATE users SET pending_attachments = $1 WHERE vk_id = $2", [JSON.stringify(['photo1_2', 'photo3_4']), STUDENT]);
        await handleMessage(ctx(STUDENT, { text: 'Вот скриншот ошибки' }), vk, GROUP);
        await handleMessage(ctx(STUDENT, { messagePayload: { command: 'confirm_send' } }), vk, GROUP);

        const ticket = (await db.query('SELECT * FROM tickets WHERE student_vk_id = $1', [STUDENT])).rows[0];
        assert.deepEqual(ticket.attachments, ['photo1_2', 'photo3_4'], 'вложения должны храниться в обращении');

        sent.length = 0;
        await handleMessage(ctx(ADMIN, { messagePayload: { command: 'take_ticket', ticket_id: ticket.id } }), vk, GROUP);
        const withPhoto = sent.find(m => m && m.attachment);
        assert.ok(withPhoto && withPhoto.attachment.includes('photo1_2'), 'фото должны прийти вместе с вопросом');
    });
});

describe('bot — из диалога всегда есть выход', () => {
    // Регрессия: на вопрос «Кто вы?» человек написал своё имя, и бот не ответил
    // ничего. Кнопки пропали, любое следующее сообщение тоже оставалось без
    // ответа, и вернуть человека можно было только удалением его из базы.
    const { handleMessage } = require('../bot')._test;
    const USER = 99999971;
    const GROUP = 999000041;

    const sent = [];
    const vk = { api: { messages: { send: async () => 1 } } };
    const ctx = (over = {}) => ({
        senderId: USER, text: null, attachments: [], messagePayload: null,
        send: async (m) => { sent.push(m); return 1; }, ...over
    });
    const said = () => sent.map(m => (m && m.message) || String(m)).join(' | ');
    const labels = () => [...JSON.stringify(sent.map(m => (m && m.keyboard) || {})).matchAll(/"label":"([^"]+)"/g)].map(x => x[1]);
    const stateOf = async () => (await db.query('SELECT state, role FROM users WHERE vk_id = $1', [USER])).rows[0];

    const setUser = async (state, role) => {
        await db.query('DELETE FROM users WHERE vk_id = $1', [USER]);
        await db.query('INSERT INTO users (vk_id, state, role, full_name, group_number) VALUES ($1, $2, $3, $4, $5)',
            [USER, state, role, role ? 'Рябцев Андрей' : null, role === 'student' ? 'РИ-240944' : null]);
    };

    after(async () => { await db.query('DELETE FROM users WHERE vk_id = $1', [USER]); });
    beforeEach(() => { sent.length = 0; });

    it('Имя вместо кнопки на вопрос «Кто вы?» — бот повторяет вопрос', async () => {
        await setUser('registration_start', null);
        await handleMessage(ctx({ text: 'Рябцев Андрей' }), vk, GROUP);

        assert.ok(sent.length > 0, 'бот не должен молчать');
        assert.ok(said().includes('Кто вы?'), said());
        assert.ok(labels().includes('Я Студент') && labels().includes('Я Администратор'), labels().join(', '));

        const u = await stateOf();
        assert.equal(u.state, 'registration_start', 'состояние должно остаться прежним');
    });

    it('Второе такое же сообщение снова получает ответ', async () => {
        await setUser('registration_start', null);
        await handleMessage(ctx({ text: 'Рябцев Андрей' }), vk, GROUP);
        sent.length = 0;
        await handleMessage(ctx({ text: 'О' }), vk, GROUP);
        assert.ok(said().includes('Кто вы?'), said());
    });

    it('Кнопка «Я Студент» после этого по-прежнему работает', async () => {
        await setUser('registration_start', null);
        await handleMessage(ctx({ text: 'что-то не то' }), vk, GROUP);
        sent.length = 0;
        await handleMessage(ctx({ text: 'Я Студент' }), vk, GROUP);

        assert.ok(said().includes('ФИО'), said());
        assert.equal((await stateOf()).state, 'reg_student_fio');
    });

    it('Произвольный текст в «Что изменить?» — повтор с кнопками', async () => {
        await setUser('profile_edit_select', 'student');
        await handleMessage(ctx({ text: 'хочу поменять всё' }), vk, GROUP);

        assert.ok(sent.length > 0, 'бот не должен молчать');
        assert.ok(labels().includes('ФИО'), labels().join(', '));
        assert.equal((await stateOf()).state, 'profile_edit_select');
    });

    it('Произвольный текст в меню заявки — повтор с кнопками', async () => {
        await setUser('ticket_manage_menu', 'student');
        await handleMessage(ctx({ text: 'удали пожалуйста' }), vk, GROUP);

        assert.ok(sent.length > 0, 'бот не должен молчать');
        assert.ok(labels().includes('❌ Удалить заявку'), labels().join(', '));
    });

    // Регрессия: кнопки этого меню в двух местах были подписаны по-разному —
    // «✏️» вместо «✏️ Изменить текст», и нажатие ни к чему не приводило
    it('Кнопки меню заявки подписаны так же, как их разбирает бот', async () => {
        await setUser('ticket_edit_text', 'student');
        await handleMessage(ctx({ text: '🔙 Назад' }), vk, GROUP);

        const shown = labels();
        assert.deepEqual(shown, ['✏️ Изменить текст', '❌ Удалить заявку', '🔙 Назад'], shown.join(', '));

        sent.length = 0;
        await handleMessage(ctx({ text: shown[0] }), vk, GROUP);
        assert.ok(said().includes('Новый текст'), said());
    });

    // Регрессия: сообщество записывалось только после полной регистрации.
    // У тех, кто до конца не дошёл, оно оставалось пустым — и напомнить им о
    // себе было не от кого: бот не знал, от имени какого сообщества писать
    it('Новому пользователю сообщество записывается сразу', async () => {
        await db.query('DELETE FROM users WHERE vk_id = $1', [USER]);
        await handleMessage(ctx({ text: 'привет' }), vk, GROUP);

        const u = (await db.query('SELECT vk_group_id, state FROM users WHERE vk_id = $1', [USER])).rows[0];
        assert.equal(String(u.vk_group_id), String(GROUP));
        assert.equal(u.state, 'registration_start');
    });

    it('Сообщество запоминается и у тех, кто ещё не выбрал роль', async () => {
        await setUser('registration_start', null);
        assert.equal((await db.query('SELECT vk_group_id FROM users WHERE vk_id = $1', [USER])).rows[0].vk_group_id, null);

        await handleMessage(ctx({ text: 'Рябцев Андрей' }), vk, GROUP);

        const u = (await db.query('SELECT vk_group_id FROM users WHERE vk_id = $1', [USER])).rows[0];
        assert.equal(String(u.vk_group_id), String(GROUP), 'сообщество должно записаться при первом же сообщении');
    });

    it('Неизвестное состояние не запирает человека', async () => {
        await setUser('состояние_из_старой_версии', 'student');
        await handleMessage(ctx({ text: 'привет' }), vk, GROUP);

        assert.ok(said().includes('меню'), said());
        assert.equal((await stateOf()).state, 'main_menu');
    });

    it('Неизвестное состояние без роли возвращает к регистрации', async () => {
        await setUser('состояние_из_старой_версии', null);
        await handleMessage(ctx({ text: 'привет' }), vk, GROUP);

        assert.ok(said().includes('Кто вы?'), said());
        assert.equal((await stateOf()).state, 'registration_start');
    });
});

describe('bot — обращения не выходят за пределы своего сообщества', () => {
    // Регрессия: очередь была общей на все курсы. Администратор, состоящий в
    // нескольких сообществах, мог взять чужой вопрос — и его ответы уходили бы
    // от имени не того сообщества. ВКонтакте такие сообщения отклоняет (студент
    // этому сообществу не писал), а администратор об этом не узнавал.
    const { handleMessage } = require('../bot')._test;
    const ADMIN = 99999961;
    const STUDENT = 99999962;
    const MINE = 999000031;      // сообщество, в котором сидит администратор
    const OTHER = 999000032;     // сообщество другого курса

    const sent = [];        // что бот ответил в текущий диалог
    const delivered = [];   // что ушло через API другому человеку
    const vk = { api: { messages: { send: async (params) => { delivered.push(params); return 1; } } } };
    const ctx = (senderId, over = {}) => ({
        senderId, text: null, attachments: [], messagePayload: null,
        send: async (m) => { sent.push(m); return 1; }, ...over
    });
    const said = () => sent.map(m => (m && m.message) || String(m)).join(' | ');

    let foreignId;

    before(async () => {
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[ADMIN, STUDENT]]);
        await db.query(`INSERT INTO users (vk_id, role, full_name, group_number, state) VALUES
            ($1, 'operator', 'Алёна', NULL, 'main_menu'),
            ($2, 'student', 'Кузнецова Мария', 'РИ-240944', 'main_menu')`, [ADMIN, STUDENT]);
        await db.query('DELETE FROM vk_groups WHERE group_id = ANY($1)', [[MINE, OTHER]]);
        await db.query(`INSERT INTO vk_groups (group_id, group_name, access_token) VALUES
            ($1, 'Первый курс ИОТ', 'test'), ($2, 'Третий курс ИОТ', 'test')`, [MINE, OTHER]);
        const r = await db.query(
            "INSERT INTO tickets (student_vk_id, vk_group_id, question, status) VALUES ($1, $2, 'Когда стипендия?', 'open') RETURNING id",
            [STUDENT, OTHER]
        );
        foreignId = r.rows[0].id;
    });
    after(async () => {
        await db.query('DELETE FROM tickets WHERE student_vk_id = $1', [STUDENT]);
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[ADMIN, STUDENT]]);
        await db.query('DELETE FROM vk_groups WHERE group_id = ANY($1)', [[MINE, OTHER]]);
    });
    beforeEach(() => { sent.length = 0; delivered.length = 0; });

    it('Вопрос другого курса не показывается в очереди', async () => {
        await handleMessage(ctx(ADMIN, { text: '📥 Очередь вопросов' }), vk, MINE);
        assert.ok(said().includes('Очередь пуста'), said());
    });

    it('В своём сообществе вопрос виден', async () => {
        await handleMessage(ctx(ADMIN, { text: '📥 Очередь вопросов' }), vk, OTHER);
        assert.ok(said().includes('Когда стипендия?'), said());
    });

    it('Взять вопрос другого курса нельзя, бот называет нужное сообщество', async () => {
        await handleMessage(ctx(ADMIN, { messagePayload: { command: 'take_ticket', ticket_id: foreignId } }), vk, MINE);
        assert.ok(said().includes('Третий курс ИОТ'), said());

        const t = (await db.query('SELECT status, operator_vk_id FROM tickets WHERE id = $1', [foreignId])).rows[0];
        assert.equal(t.status, 'open', 'обращение должно остаться в очереди своего курса');
        assert.equal(t.operator_vk_id, null, 'администратор не должен быть назначен');
    });

    it('Сообщение из чужого сообщества не уходит собеседнику', async () => {
        const r = await db.query(
            "INSERT INTO tickets (student_vk_id, vk_group_id, operator_vk_id, question, status) VALUES ($1, $2, $3, 'Вопрос', 'active') RETURNING id",
            [STUDENT, OTHER, ADMIN]
        );
        await db.query("UPDATE users SET state = 'chat_mode', current_chat_ticket_id = $1 WHERE vk_id = $2", [r.rows[0].id, ADMIN]);

        await handleMessage(ctx(ADMIN, { text: 'Стипендия будет 25 числа' }), vk, MINE);

        assert.equal(delivered.length, 0, 'ничего не должно уйти через чужое сообщество');
        assert.ok(said().includes('Третий курс ИОТ'), said());

        const saved = await db.query('SELECT count(*) FROM messages WHERE ticket_id = $1', [r.rows[0].id]);
        assert.equal(Number(saved.rows[0].count), 0, 'сообщение не должно попасть и в переписку');

        await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [ADMIN]);
    });

    it('Выйти в меню можно из любого сообщества', async () => {
        const r = await db.query(
            "INSERT INTO tickets (student_vk_id, vk_group_id, operator_vk_id, question, status) VALUES ($1, $2, $3, 'Вопрос', 'active') RETURNING id",
            [STUDENT, OTHER, ADMIN]
        );
        await db.query("UPDATE users SET state = 'chat_mode', current_chat_ticket_id = $1 WHERE vk_id = $2", [r.rows[0].id, ADMIN]);

        await handleMessage(ctx(ADMIN, { text: '⬅️ Назад к списку' }), vk, MINE);

        const u = (await db.query('SELECT state, current_chat_ticket_id FROM users WHERE vk_id = $1', [ADMIN])).rows[0];
        assert.equal(u.state, 'main_menu');
        assert.equal(u.current_chat_ticket_id, null);
    });
});

describe('bot — списки обращений умещаются в сообщение ВКонтакте', () => {
    const { handleMessage, sendTicketList, LIST_PAGE_SIZE, LIST_PREVIEW } = require('../bot')._test;
    const ADMIN = 99999951;
    const STUDENT = 99999952;
    const GROUP = 999000019;

    // Ограничения ВКонтакте: 4096 символов в сообщении, 6 строк в inline-клавиатуре
    const VK_MESSAGE_LIMIT = 4096;
    const VK_INLINE_ROWS = 6;

    const sent = [];
    const vk = { api: { messages: { send: async () => 1 } } };
    const ctx = (senderId, over = {}) => ({
        senderId, text: null, attachments: [], messagePayload: null,
        send: async (m) => { sent.push(m); return 1; }, ...over
    });
    const listMessage = () => sent.find(m => m && m.keyboard && /Очередь|диалог|обращени/i.test(String(m.message)));
    const rowsOf = (m) => (m && m.keyboard && m.keyboard.buttons ? m.keyboard.buttons.length : 0);
    const labelsOf = (m) => [...JSON.stringify((m && m.keyboard) || {}).matchAll(/"label":"([^"]+)"/g)].map(x => x[1]);

    // Девять вопросов по 3000 символов: вместе это больше 27 000 символов
    const HUGE = 'Очень длинный вопрос студента. '.repeat(100);

    before(async () => {
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[ADMIN, STUDENT]]);
        await db.query(`INSERT INTO users (vk_id, role, full_name, group_number, state) VALUES
            ($1, 'operator', 'Алёна', NULL, 'main_menu'),
            ($2, 'student', 'Кузнецова Мария', 'РИ-240944', 'main_menu')`, [ADMIN, STUDENT]);
        for (let i = 0; i < 9; i++) {
            await db.query(
                "INSERT INTO tickets (student_vk_id, vk_group_id, question, status) VALUES ($1, $2, $3, 'open')",
                [STUDENT, GROUP, `${HUGE} (вопрос ${i + 1})`]
            );
        }
        assert.ok(HUGE.length > 2500, 'вопрос должен быть заведомо длинным');
    });
    after(async () => {
        await db.query('DELETE FROM tickets WHERE student_vk_id = $1', [STUDENT]);
        await db.query('DELETE FROM users WHERE vk_id = ANY($1)', [[ADMIN, STUDENT]]);
    });
    beforeEach(() => { sent.length = 0; });

    // Регрессия: список склеивал вопросы целиком — на длинных вопросах
    // сообщение превышало лимит ВКонтакте и не отправлялось вообще
    it('Очередь из девяти длинных вопросов умещается в лимит сообщения', async () => {
        await handleMessage(ctx(ADMIN, { text: '📥 Очередь вопросов' }), vk, GROUP);

        const list = listMessage();
        assert.ok(list, 'список должен отправиться');
        assert.ok(list.message.length < VK_MESSAGE_LIMIT, `длина сообщения ${list.message.length}`);
        assert.ok(rowsOf(list) <= VK_INLINE_ROWS, `строк клавиатуры ${rowsOf(list)}`);
    });

    it('Показано, сколько обращений видно и сколько всего', async () => {
        await handleMessage(ctx(ADMIN, { text: '📥 Очередь вопросов' }), vk, GROUP);

        const list = listMessage();
        assert.ok(list.message.includes(`Показаны 1–${LIST_PAGE_SIZE} из 9`), list.message.slice(0, 120));
        assert.ok(labelsOf(list).includes('Вперёд ▶'), 'должна быть кнопка следующей страницы');
        assert.ok(!labelsOf(list).includes('◀ Назад'), 'на первой странице кнопки назад быть не должно');
    });

    it('Вопрос в списке показан выдержкой, а не целиком', async () => {
        await handleMessage(ctx(ADMIN, { text: '📥 Очередь вопросов' }), vk, GROUP);

        const list = listMessage();
        const longest = list.message.split('\n').reduce((a, b) => (a.length > b.length ? a : b));
        assert.ok(longest.length <= LIST_PREVIEW + 5, `строка вопроса ${longest.length} символов`);
        assert.ok(list.message.includes('…'), 'выдержка должна обрываться многоточием');
    });

    it('Перелистывание вперёд и назад показывает разные обращения', async () => {
        await handleMessage(ctx(ADMIN, { messagePayload: { command: 'list_page', list: 'queue', page: 1 } }), vk, GROUP);
        const second = listMessage();
        assert.ok(second.message.includes(`Показаны ${LIST_PAGE_SIZE + 1}–${LIST_PAGE_SIZE * 2} из 9`), second.message.slice(0, 120));
        const labels = labelsOf(second);
        assert.ok(labels.includes('◀ Назад') && labels.includes('Вперёд ▶'));

        sent.length = 0;
        await handleMessage(ctx(ADMIN, { messagePayload: { command: 'list_page', list: 'queue', page: 2 } }), vk, GROUP);
        const third = listMessage();
        assert.ok(third.message.includes('из 9'));
        assert.ok(!labelsOf(third).includes('Вперёд ▶'), 'на последней странице кнопки вперёд быть не должно');
    });

    it('Номер страницы за пределами списка не ломает вывод', async () => {
        await handleMessage(ctx(ADMIN, { messagePayload: { command: 'list_page', list: 'queue', page: 999 } }), vk, GROUP);
        const list = listMessage();
        assert.ok(list && list.message.includes('из 9'), 'должна показаться последняя страница');
    });

    it('Студент не может открыть очередь администратора', async () => {
        await handleMessage(ctx(STUDENT, { messagePayload: { command: 'list_page', list: 'queue', page: 0 } }), vk, GROUP);
        assert.ok(String(sent[0]).includes('недоступен'), String(sent[0]));
    });

    it('Список своих обращений у студента тоже постраничный', async () => {
        await handleMessage(ctx(STUDENT, { text: '🗂 Мои обращения' }), vk, GROUP);

        const list = listMessage();
        assert.ok(list.message.length < VK_MESSAGE_LIMIT);
        assert.ok(list.message.includes('из 9'));
        assert.ok(rowsOf(list) <= VK_INLINE_ROWS);
    });

    it('Пустой список сообщает об этом без клавиатуры', async () => {
        await db.query("UPDATE tickets SET status = 'closed' WHERE student_vk_id = $1", [STUDENT]);
        sent.length = 0;
        await sendTicketList(ctx(ADMIN), ADMIN, 'queue', 0, GROUP);
        assert.ok(String(sent[0]).includes('Очередь пуста'), String(sent[0]));
        await db.query("UPDATE tickets SET status = 'open' WHERE student_vk_id = $1", [STUDENT]);
    });
});
