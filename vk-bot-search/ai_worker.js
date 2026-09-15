require('dotenv').config();
const { db } = require('./database');
const { askOllama, askGigaChat, getGigaChatChain } = require('./ai_service');
const { Keyboard } = require('vk-io');

// Слоты параллелизма.
// GigaChat: физлицам во freemium доступен РОВНО ОДИН поток, поэтому облачные
// запросы строго последовательны. Ollama держит свой независимый слот и
// работает как резерв, когда облако недоступно или занято.
let gigaChatBusy = false;
let ollamaBusy = false;

// Провайдеры вызываются через этот объект, чтобы их можно было подменить
// в тестах и проверить поведение очереди без сети и живых моделей.
const providers = { askOllama, askGigaChat, getGigaChatChain };

// Скользящее окно длительностей генерации — на нём строится честная оценка
// времени ожидания (EWT). Раньше EWT считался по константе «10 ответов в минуту».
const DURATION_WINDOW = 20;
const DEFAULT_DURATION_SEC = 15;
const durations = [];

function recordDuration(seconds) {
    durations.push(seconds);
    if (durations.length > DURATION_WINDOW) durations.shift();
}

function averageDuration() {
    if (durations.length === 0) return DEFAULT_DURATION_SEC;
    return durations.reduce((a, b) => a + b, 0) / durations.length;
}

/** Статистика для расчёта времени ожидания в bot.js */
function getQueueStats() {
    return { avgSeconds: averageDuration(), slots: 2, samples: durations.length };
}

const answerKeyboard = () => Keyboard.builder()
    .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).row()
    .textButton({ label: '👨‍💼 Передать админу', payload: { command: 'operator_request' }, color: Keyboard.PRIMARY_COLOR });

/**
 * Получает ответ у провайдеров в порядке: облако -> локальная модель.
 * Внутри облака поднимается по классам моделей, если квота класса исчерпана.
 *
 * Бросает ошибку с флагом noCapacity, если ни один провайдер не свободен —
 * это НЕ сбой задачи, её нужно просто вернуть в очередь.
 */
async function generate(task) {
    let cloudError = null;

    // 1. Облако — основной провайдер: быстрее и точнее локальной модели
    if (!gigaChatBusy) {
        gigaChatBusy = true;
        try {
            const chain = await providers.getGigaChatChain();

            if (chain.length === 0) {
                cloudError = new Error('Все квоты GigaChat исчерпаны');
            }

            for (const model of chain) {
                try {
                    return await providers.askGigaChat(task.ai_context, task.faq_context, model.id);
                } catch (err) {
                    cloudError = err;
                    if (err.quotaExhausted) {
                        console.log(`[Worker] Квота ${model.id} исчерпана, пробуем следующий класс модели`);
                        continue;
                    }
                    console.log(`[Worker] GigaChat (${model.id}) ошибка: ${err.message}`);
                    break; // обычный сбой — не перебираем модели, уходим в резерв
                }
            }
        } finally {
            gigaChatBusy = false;
        }
    }

    // 2. Локальная модель — резерв
    if (!ollamaBusy) {
        ollamaBusy = true;
        try {
            if (cloudError) console.log('[Worker] Переключаемся на резервную модель Ollama');
            return await providers.askOllama(task.ai_context, task.faq_context);
        } catch (err) {
            throw cloudError || err;
        } finally {
            ollamaBusy = false;
        }
    }

    // 3. Реальной попытки не было — все слоты заняты
    if (cloudError) throw cloudError;
    const busy = new Error('Нет свободного провайдера, задача ждёт своей очереди');
    busy.noCapacity = true;
    throw busy;
}

/** Возврат задачи в очередь без списания попытки */
async function requeue(taskId, reason) {
    console.log(`[Worker] Задача ${taskId} возвращена в очередь: ${reason}`);
    await db.query("UPDATE ai_queue SET status = 'pending', started_at = NULL WHERE id = $1", [taskId]);
}

/** Реальный сбой: списываем попытку и решаем — повторить или сдаться */
async function handleFailure(task, err) {
    console.log(`[Worker] Ошибка обработки задачи ${task.id}: ${err.message}`);

    let attempts;
    try {
        const res = await db.query(
            'UPDATE ai_queue SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
            [task.id]
        );
        if (res.rows.length === 0) return; // задачу успели отменить
        attempts = res.rows[0].attempts;
    } catch (dbErr) {
        console.error('[Worker] Не удалось обновить счётчик попыток:', dbErr.message);
        return;
    }

    if (attempts < 2) {
        await requeue(task.id, `попытка ${attempts} из 2 не удалась`);
        return;
    }

    // Защита Poison Pill: задача стабильно валит обработку — снимаем её
    console.error(`[Worker] Задача ${task.id} помечена как error (Poison Pill, попыток: ${attempts})`);
    await db.query("UPDATE ai_queue SET status = 'error' WHERE id = $1", [task.id]);

    const bot = global.bots && global.bots[task.vk_group_id];
    if (bot) {
        await bot.api.messages.send({
            user_id: task.vk_id,
            random_id: Math.floor(Math.random() * 1000000),
            message: '⚠️ Извините, произошла системная ошибка при обращении к ИИ-ассистенту. Пожалуйста, передайте ваш вопрос администратору.',
            keyboard: answerKeyboard()
        }).catch(sendErr => console.error('[Worker] Не удалось отправить уведомление об ошибке:', sendErr.message));
    }
}

async function processTask(task) {
    let result;
    const startedAt = Date.now();

    try {
        result = await generate(task);
    } catch (err) {
        if (err.noCapacity) {
            // Провайдеры заняты — это нормальная ситуация под нагрузкой,
            // а не ошибка задачи. Попытку не списываем.
            await requeue(task.id, 'все провайдеры заняты');
            return;
        }
        await handleFailure(task, err);
        return;
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    recordDuration(elapsed);
    console.log(`[Worker] ${result.provider} (${result.model}) ответил за ${elapsed.toFixed(1)}с, токенов: ${result.tokens}`);

    try {
        const bot = global.bots && global.bots[task.vk_group_id];
        if (!bot) throw new Error(`Бот для группы ${task.vk_group_id} не найден`);

        // Пока модель генерировала ответ, пользователь мог нажать «Отменить» —
        // bot.js удаляет задачу из очереди, поэтому проверяем до отправки
        const stillExists = await db.query('SELECT id FROM ai_queue WHERE id = $1', [task.id]);
        if (stillExists.rows.length === 0) {
            console.log(`[Worker] Задача ${task.id} отменена во время генерации, ответ не отправляем`);
            return;
        }

        task.ai_context.push({ role: 'assistant', content: result.text, model: result.model });
        await db.query(
            "UPDATE users SET ai_context = $1, state = 'ask_question_mode' WHERE vk_id = $2",
            [JSON.stringify(task.ai_context), task.vk_id]
        );
        await db.query('DELETE FROM ai_queue WHERE id = $1', [task.id]);

        await bot.api.messages.send({
            user_id: task.vk_id,
            random_id: Math.floor(Math.random() * 1000000),
            message: `🤖 ${result.text}`,
            keyboard: answerKeyboard()
        });

        console.log(`[Worker] Задача ${task.id} выполнена через ${result.provider}`);
        console.log(`[AI_RESPONSE] Ответ: "${result.text.substring(0, 500)}${result.text.length > 500 ? '...' : ''}"`);
    } catch (err) {
        await handleFailure(task, err);
    }
}

async function processQueue() {
    if (gigaChatBusy && ollamaBusy) {
        return; // Оба слота заняты — за задачей вернёмся следующим тиком
    }

    // ВАЖНО: db.connect() внутри обработчика ошибок. Раньше он стоял снаружи,
    // и недоступность БД превращалась в необработанный reject внутри setInterval,
    // из-за чего Node убивал весь процесс — падал не воркер, а бот целиком.
    let client;
    try {
        client = await db.connect();
    } catch (err) {
        console.error('[Worker] Нет соединения с БД, пропускаем тик:', err.message);
        return;
    }

    // Пока соединение выдано воркеру, обработчик пула его не слушает.
    // Если база упадёт между BEGIN и COMMIT, ошибка придёт событием на сам
    // клиент — без слушателя это снова завершило бы процесс.
    let connectionLost = null;
    const onClientError = (err) => {
        connectionLost = err;
        console.error('[Worker] Соединение с БД оборвалось во время транзакции:', err.message);
    };
    client.on('error', onClientError);

    try {
        await client.query('BEGIN');

        const result = await client.query(`
            SELECT id FROM ai_queue
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `);

        if (result.rows.length === 0) {
            await client.query('COMMIT');
            return;
        }

        // attempts здесь НЕ увеличиваем: попытка засчитывается только при
        // реальном сбое генерации. Иначе занятость провайдеров за два тика
        // доводила счётчик до предела и студент получал «системную ошибку».
        const updated = await client.query(
            "UPDATE ai_queue SET status = 'processing', started_at = NOW() WHERE id = $1 RETURNING *",
            [result.rows[0].id]
        );
        await client.query('COMMIT');

        const task = updated.rows[0];
        console.log(`[Worker] Взята задача ${task.id} (сбоев ранее: ${task.attempts})`);

        // Запускаем асинхронно БЕЗ await — но обязательно с перехватом,
        // иначе ошибка внутри самого обработчика ошибок уронит процесс
        processTask(task)
            .catch(err => console.error(`[Worker] Необработанная ошибка задачи ${task.id}:`, err.message));
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error('[Worker] Не удалось откатить транзакцию:', rollbackErr.message);
        }
        console.error('[Worker] Ошибка БД в processQueue:', err.message);
    } finally {
        client.off('error', onClientError);
        // Оборванное соединение уничтожаем, а не возвращаем в пул
        client.release(connectionLost || undefined);
    }
}

async function cleanZombieTasks() {
    try {
        // Ищем по started_at — моменту взятия в работу. По created_at (времени
        // постановки в очередь) задача, пролежавшая в очереди дольше таймаута,
        // сбрасывалась сразу после старта и обрабатывалась дважды.
        const result = await db.query(`
            UPDATE ai_queue
            SET status = 'pending', started_at = NULL
            WHERE status = 'processing'
              AND started_at IS NOT NULL
              AND started_at < NOW() - INTERVAL '10 minutes'
            RETURNING id
        `);
        if (result.rowCount > 0) {
            console.log(`[Worker] Возвращено в очередь зависших задач: ${result.rowCount}`);
        }
    } catch (err) {
        console.error('[Worker] Ошибка очистки зависших задач:', err.message);
    }
}

function startWorker() {
    console.log('[Worker] AI Queue worker запущен (приоритет: GigaChat, резерв: Ollama)');
    // Колбэк setInterval не имеет владельца, который поймает reject,
    // поэтому оборачиваем оба цикла явным catch
    setInterval(() => {
        processQueue().catch(err => console.error('[Worker] processQueue:', err.message));
    }, 3000);
    setInterval(() => {
        cleanZombieTasks().catch(err => console.error('[Worker] cleanZombieTasks:', err.message));
    }, 5 * 60 * 1000);
}

module.exports = {
    startWorker,
    getQueueStats,
    // Для тестов: подмена провайдеров и управление слотами занятости
    _test: {
        generate,
        providers,
        setBusy: (giga, ollama) => { gigaChatBusy = giga; ollamaBusy = ollama; },
        recordDuration,
        averageDuration
    }
};
