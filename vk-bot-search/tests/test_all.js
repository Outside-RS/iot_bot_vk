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
        const user = await makeStudent('РИ-140944', null);
        const updated = await reconcileStudentCourse(ctx, user, G2);

        assert.equal(updated.group_number, 'РИ-240944');
        const row = (await db.query('SELECT group_number, vk_group_id FROM users WHERE vk_id = $1', [STUDENT])).rows[0];
        assert.equal(row.group_number, 'РИ-240944');
        assert.equal(String(row.vk_group_id), String(G2), 'сообщество должно запомниться');
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
