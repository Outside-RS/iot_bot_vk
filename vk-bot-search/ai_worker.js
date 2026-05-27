require('dotenv').config();
const { db } = require('./database');
const { askOllama, askGigaChat } = require('./ai_service');
const { Keyboard } = require('vk-io');

let isOllamaBusy = false;
let isGigaChatBusy = false;

async function processTask(task) {
    let usedModel = null;
    let responseText = null;

    try {
        if (!isOllamaBusy) {
            isOllamaBusy = true;
            try {
                usedModel = 'Ollama';
                const startTime = Date.now();
                responseText = await askOllama(task.ai_context, task.faq_context);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`[Worker] Ollama responded in ${elapsed}s`);
            } catch (err) {
                console.log(`[Worker] Ollama error for task ${task.id}, attempting GigaChat...`);
                isOllamaBusy = false;

                if (!isGigaChatBusy) {
                    isGigaChatBusy = true;
                    try {
                        usedModel = 'GigaChat';
                        const startTime = Date.now();
                        responseText = await askGigaChat(task.ai_context, task.faq_context);
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                        console.log(`[Worker] GigaChat responded in ${elapsed}s`);
                    } finally {
                        isGigaChatBusy = false;
                    }
                } else {
                    throw err;
                }
            } finally {
                isOllamaBusy = false;
            }
        } else if (!isGigaChatBusy) {
            isGigaChatBusy = true;
            try {
                usedModel = 'GigaChat';
                const startTime = Date.now();
                responseText = await askGigaChat(task.ai_context, task.faq_context);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`[Worker] GigaChat responded in ${elapsed}s`);
            } finally {
                isGigaChatBusy = false;
            }
        } else {
            throw new Error('Both models busy, task skipped');
        }

        if (responseText) {
            const bot = global.bots && global.bots[task.vk_group_id];
            if (!bot) {
                throw new Error(`Бот для группы ${task.vk_group_id} не найден`);
            }

            // Пока LLM генерировала ответ, пользователь мог нажать «Отменить» —
            // bot.js удаляет задачу из очереди, поэтому проверяем до отправки
            const stillExists = await db.query('SELECT id FROM ai_queue WHERE id = $1', [task.id]);
            if (stillExists.rows.length === 0) {
                console.log(`[Worker] Task ${task.id} cancelled during generation, skipping`);
                return;
            }

            task.ai_context.push({ role: 'assistant', content: responseText, model: usedModel });
            await db.query("UPDATE users SET ai_context = $1, state = 'ask_question_mode' WHERE vk_id = $2", [JSON.stringify(task.ai_context), task.vk_id]);
            await db.query('DELETE FROM ai_queue WHERE id = $1', [task.id]);



            const kb = Keyboard.builder()
                .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).row()
                .textButton({ label: '👨‍💼 Передать админу', payload: { command: 'operator_request' }, color: Keyboard.PRIMARY_COLOR });

            await bot.api.messages.send({
                user_id: task.vk_id,
                random_id: Math.floor(Math.random() * 1000000),
                message: `🤖 ${responseText}`,
                keyboard: kb
            });
            console.log(`[Worker] Task ${task.id} processed successfully via ${usedModel}`);
            console.log(`[AI_RESPONSE] Ответ: "${responseText.substring(0, 500)}${responseText.length > 500 ? '...' : ''}"`);
        }
    } catch (globalErr) {
        console.error(`[Worker] Error processing task ${task.id}:`, globalErr.message);

        if (task.attempts < 2) {
            console.log(`[Worker] Task ${task.id} returned to pending (attempts: ${task.attempts})`);
            await db.query("UPDATE ai_queue SET status = 'pending' WHERE id = $1", [task.id]);
        } else {
            console.log(`[Worker] Task ${task.id} marked as error (Poison Pill protection)`);
            await db.query("UPDATE ai_queue SET status = 'error' WHERE id = $1", [task.id]);

            const bot = global.bots && global.bots[task.vk_group_id];
            if (bot) {
                const kb = Keyboard.builder()
                    .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).row()
                    .textButton({ label: '👨‍💼 Передать админу', payload: { command: 'operator_request' }, color: Keyboard.PRIMARY_COLOR });
                await bot.api.messages.send({
                    user_id: task.vk_id,
                    random_id: Math.floor(Math.random() * 1000000),
                    message: "⚠️ Извините, произошла системная ошибка при обращении к ИИ-ассистенту. Пожалуйста, передайте ваш вопрос администратору.",
                    keyboard: kb
                });
            }
        }
    }
}

async function processQueue() {
    if (isOllamaBusy && isGigaChatBusy) {
        return; // Обе кассы заняты
    }

    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const result = await client.query(`
            SELECT * FROM ai_queue 
            WHERE status = 'pending' 
            ORDER BY created_at ASC 
            LIMIT 1 
            FOR UPDATE SKIP LOCKED
        `);

        if (result.rows.length > 0) {
            const updatedTaskRes = await client.query(`
                UPDATE ai_queue 
                SET status = 'processing', attempts = attempts + 1 
                WHERE id = $1 
                RETURNING *
            `, [result.rows[0].id]);

            await client.query('COMMIT');

            const updatedTask = updatedTaskRes.rows[0];
            console.log(`[Worker] Picked task ${updatedTask.id} (attempt ${updatedTask.attempts})`);

            // Запускаем асинхронно БЕЗ await
            processTask(updatedTask);
        } else {
            await client.query('COMMIT');
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Worker] DB Error in processQueue:', err.message);
    } finally {
        client.release();
    }
}

async function cleanZombieTasks() {
    try {
        const result = await db.query(`
            UPDATE ai_queue 
            SET status = 'pending' 
            WHERE status = 'processing' 
            AND created_at < NOW() - INTERVAL '10 minutes'
            RETURNING id
        `);
        if (result.rowCount > 0) {
            console.log(`[Worker] Reverted ${result.rowCount} zombie tasks to pending`);
        }
    } catch (err) {
        console.error('[Worker] Error cleaning zombie tasks:', err.message);
    }
}

function startWorker() {
    console.log('[Worker] AI Queue worker started');
    setInterval(processQueue, 3000);
    setInterval(cleanZombieTasks, 5 * 60 * 1000); // Раз в 5 минут
}

module.exports = { startWorker };
