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

