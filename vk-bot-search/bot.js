// bot.js
const { VK, Keyboard } = require('vk-io');
const { db } = require('./database');
const { getQueueStats } = require('./ai_worker');
const { searchFaq, buildDialogHints, DIRECT_MIN_SCORE } = require('./faq_search');
const { courseOfGroup, withCourse } = require('./courses');

// ==================== Логи ====================
// Теги: [BOT] — события диалога, [FSM] — состояние пользователя, [SEARCH] — поиск,
// [QUEUE] — очередь ИИ, [TICKET] — обращения к администраторам, [VK] — связь с VK,
// [SECURITY] — подозрительные действия. Уровни и файлы — см. logger.js.
const log = (msg) => console.info(`[BOT] ${msg}`);

/** Текст в одну строку ограниченной длины — чтобы запись лога оставалась читаемой */
const preview = (text, max = 200) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** Что прислал пользователь: текст, нажатая кнопка, вложения */
function describeIncoming(context) {
    const parts = [];
    if (context.text) parts.push(`«${preview(context.text)}»`);
    if (context.messagePayload && context.messagePayload.command) parts.push(`[кнопка ${context.messagePayload.command}]`);
    const atts = context.attachments || [];
    if (atts.length > 0) {
        const byType = {};
        for (const a of atts) byType[a.type] = (byType[a.type] || 0) + 1;
        parts.push(`[вложения: ${Object.entries(byType).map(([t, n]) => `${t}×${n}`).join(', ')}]`);
    }
    return parts.join(' ') || '(пусто)';
}

/**
 * Логирует каждый ответ бота в диалоге. В bot.js десятки вызовов context.send —
 * вместо логов в каждом из них оборачиваем сам метод один раз на сообщение.
 */
function instrumentSend(context) {
    const send = context.send.bind(context);
    context.send = async (params, ...rest) => {
        const text = typeof params === 'string' ? params : (params && params.message) || '';
        try {
            const result = await send(params, ...rest);
            console.debug(`[VK] → ${context.senderId}: ${preview(text, 150)}`);
            return result;
        } catch (err) {
            console.error(`[VK] Не удалось ответить пользователю ${context.senderId}:`, err);
            throw err;
        }
    };
}

/** Отправка через API (уведомления другим людям) с логом результата, без падения */
async function notify(vk, peerId, params, what) {
    try {
        await vk.api.messages.send({ peer_id: peerId, random_id: 0, ...params });
        console.debug(`[VK] → ${peerId}: ${what}`);
        return true;
    } catch (err) {
        // Частая причина — пользователь запретил сообщения от сообщества (код 901)
        console.warn(`[VK] Не доставлено ${peerId} (${what}):`, err);
        return false;
    }
}

const REGEX_FIO = /^[А-Яа-яЁё]+\s+[А-Яа-яЁё]+.*$/;
const REGEX_GROUP = /^[А-Я]{2,}-\d{6}$/;

// Payload кнопки формируется на стороне клиента, а VK API позволяет отправить
// сообщение с произвольным payload. Поэтому всё, что приходит оттуда, считаем
// недоверенным: id приводим к числу, права на объект проверяем отдельным запросом.
const parseId = (value) => {
    const id = Number.parseInt(value, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
};

// Возвращает тикет, только если пользователь — его участник (студент или назначенный админ)
async function getTicketIfParticipant(ticketId, vkId) {
    const res = await db.query(
        'SELECT * FROM tickets WHERE id = $1 AND (student_vk_id = $2 OR operator_vk_id = $2)',
        [ticketId, vkId]
    );
    return res.rows[0] || null;
}

async function getRole(vkId) {
    const res = await db.query('SELECT role FROM users WHERE vk_id = $1', [vkId]);
    return res.rows.length > 0 ? res.rows[0].role : null;
}

// ==================== Курс студента по сообществу ====================
// Источник истины — курсовое сообщество (см. courses.js): вступление в него
// модерируется, а номер группы студент вводит сам и может ошибиться.

async function getCommunity(groupId) {
    const res = await db.query('SELECT course, is_archived FROM vk_groups WHERE group_id = $1', [groupId]);
    return res.rows[0] || null;
}

/** Номер группы против курса сообщества. Возвращает текст отказа или null, если всё сходится. */
async function checkGroupAgainstCommunity(groupNumber, groupId) {
    const community = await getCommunity(groupId);
    // Курс сообщества неизвестен (тестовое, архивное) — проверять не с чем
    if (!community || community.is_archived || !community.course) return null;
    const entered = courseOfGroup(groupNumber);
    if (entered === community.course) return null;
    return `В этом сообществе учатся студенты ${community.course} курса, а группа ${groupNumber} указывает на ${entered} курс (первая цифра после дефиса — номер курса). Проверьте номер группы.`;
}

/**
 * Приводит данные студента в соответствие с его сообществом.
 *
 * 1. Запоминает сообщество, если оно ещё не известно. Раньше vk_group_id
 *    записывался только при вопросе к ИИ — большинство студентов были «ничьи».
 * 2. Если сообщество ушло в архив — отмечает выпуск.
 * 3. Если цифра курса в номере группы не совпадает с курсом сообщества —
 *    исправляет её и сообщает студенту. Так догоняются записи, которые
 *    не перевели при переименовании (например, cron 1 августа 2026 не был подключён).
 *
 * Трогаем только сообщение из «своего» сообщества: если студент пишет
 * из чужого, его данные не меняются.
 */
async function reconcileStudentCourse(context, user, groupId) {
    if (user.role !== 'student' || user.is_graduated || !user.group_number) return user;
    if (/^(reg|registration|edit_)/.test(user.state || '')) return user;

    if (!user.vk_group_id) {
        await db.query('UPDATE users SET vk_group_id = $1 WHERE vk_id = $2 AND vk_group_id IS NULL', [groupId, user.vk_id]);
        console.info(`[COURSE] ${user.vk_id}: запомнено сообщество ${groupId}`);
        user = { ...user, vk_group_id: groupId };
    }
    if (String(user.vk_group_id) !== String(groupId)) return user;

    const community = await getCommunity(groupId);
    if (!community) return user;

    if (community.is_archived) {
        await db.query('UPDATE users SET is_graduated = TRUE WHERE vk_id = $1', [user.vk_id]);
        console.info(`[COURSE] ${user.vk_id}: сообщество в архиве — студент отмечен выпускником`);
        return { ...user, is_graduated: true };
    }
    if (!community.course) return user;

    const current = courseOfGroup(user.group_number);
    if (current === null || current === community.course) return user;

    const fixed = withCourse(user.group_number, community.course);
    await db.query('UPDATE users SET group_number = $1 WHERE vk_id = $2', [fixed, user.vk_id]);
    console.info(`[COURSE] ${user.vk_id}: номер группы приведён к курсу сообщества — ${user.group_number} → ${fixed}`);
    await context.send(`ℹ️ Мы обновили номер вашей группы под текущий курс: ${user.group_number} → ${fixed}. Если это ошибка, поправьте группу в профиле.`);
    return { ...user, group_number: fixed };
}

const resolveAttachments = (attachments) => {
    if (!attachments) return [];
    return attachments.map(att => `${att.type}${att.ownerId}_${att.id}${att.accessKey ? '_' + att.accessKey : ''}`);
};

// Ограничение сообществ для локального запуска.
// Токены групп хранятся в БД, поэтому локальная копия с базой, где остались
// продовые сообщества, подключилась бы к ним параллельно с продом и начала
// перехватывать сообщения студентов. Если ALLOWED_GROUP_IDS задан, бот
// подключается только к перечисленным группам; если не задан — ко всем (прод).
function getAllowedGroupIds() {
    return (process.env.ALLOWED_GROUP_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(id => id.length > 0);
}

function isGroupAllowed(groupId) {
    const allowed = getAllowedGroupIds();
    return allowed.length === 0 || allowed.includes(String(groupId));
}

// Фабричная функция для создания экземпляра бота
function createBotInstance(token, groupId, groupName) {
    // Единая точка проверки: сюда приходят и старт при запуске сервера,
    // и динамическое включение группы из админки
    if (!isGroupAllowed(groupId)) {
        throw new Error(`группа не входит в ALLOWED_GROUP_IDS — подключение запрещено (локальный режим)`);
    }

    const vk = new VK({ token });

    // Регистрируем обработчик сообщений для этого экземпляра
    vk.updates.on('message_new', async (context) => {
        if (context.isOutbox) return;
        instrumentSend(context);
        await handleMessage(context, vk, groupId);
    });

    log(`Инициализирован бот для группы: ${groupName} (ID: ${groupId})`);
    return vk;
}

// Основной обработчик сообщений
async function handleMessage(context, vk, groupId) {
    const { text, senderId, messagePayload, attachments } = context;

    if (!text && !messagePayload && attachments.length === 0) return;

    console.info(`[BOT] ← ${senderId} (группа ${groupId}): ${describeIncoming(context)}`);

    if (text && text.length > 1000) {
        console.info(`[BOT] Сообщение от ${senderId} отклонено: ${text.length} символов при лимите 1000`);
        return context.send('❌ Сообщение слишком длинное. Максимум — 1000 символов.');
    }

    try {
        // 1. ОБРАБОТКА КНОПОК
        if (messagePayload) {
            if (messagePayload.command === 'logout') {
                await db.query('DELETE FROM users WHERE vk_id = $1', [senderId]);
                console.info(`[BOT] ${senderId} вышел из аккаунта (профиль удалён)`);
                return context.send({ message: 'Вы вышли. Напишите любое сообщение для начала работы.', keyboard: Keyboard.keyboard([]) });
            }
            if (messagePayload.command === 'show_faq_answer') {
                const faqId = messagePayload.faq_id;
                const faqRes = await db.query('SELECT question, answer FROM faq WHERE id = $1', [faqId]);
                if (faqRes.rows.length > 0) {
                    const row = faqRes.rows[0];
                    console.info(`[SEARCH] ${senderId} выбрал вариант FAQ #${faqId}: «${preview(row.question, 80)}»`);
                    await context.send({
                        message: `📚 ${row.question}\n\n${row.answer}`,
                        keyboard: Keyboard.builder().textButton({ label: '✉️ Передать администратору', payload: { command: 'confirm_send', question: row.question }, color: Keyboard.POSITIVE_COLOR }).row().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).oneTime()
                    });
                } else { await context.send('Ошибка: ответ не найден.'); }
                return;
            }
            if (messagePayload.command === 'take_ticket') {
                const ticketId = parseId(messagePayload.ticket_id);
                if (!ticketId) return context.send('Некорректный номер тикета.');
                // Брать тикеты в работу может только администратор
                if (await getRole(senderId) !== 'operator') {
                    console.warn(`[SECURITY] Отказ take_ticket: ${senderId} не администратор (тикет ${ticketId}) — возможна подделка кнопки`);
                    return context.send('Эта команда доступна только администраторам.');
                }
                const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
                if (ticketRes.rows.length === 0) return context.send('Тикет не найден.');
                if (ticketRes.rows[0].status !== 'open') return context.send('Тикет уже занят.');
                await db.query("UPDATE tickets SET operator_vk_id = $1, status = 'active' WHERE id = $2", [senderId, ticketId]);
                await db.query("UPDATE users SET current_chat_ticket_id = $1, state = 'chat_mode' WHERE vk_id = $2", [ticketId, senderId]);
                console.info(`[TICKET] Тикет #${ticketId} взят администратором ${senderId}`);
                await notify(vk, ticketRes.rows[0].student_vk_id, { message: `👨‍💻 Администратор подключился к вопросу #${ticketId}.`, keyboard: Keyboard.builder().textButton({ label: `Перейти к #${ticketId}`, payload: { command: 'open_chat', ticket_id: ticketId }, color: Keyboard.POSITIVE_COLOR }).inline() }, `уведомление: администратор взял тикет #${ticketId}`);
                await context.send({ message: `Вы взяли тикет #${ticketId}.`, keyboard: Keyboard.builder().textButton({ label: '🏁 Завершить этот тикет', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '⬅️ Назад к списку', color: Keyboard.SECONDARY_COLOR }) });
                return;
            }
            if (messagePayload.command === 'open_chat') {
                const ticketId = parseId(messagePayload.ticket_id);
                if (!ticketId) return context.send('Некорректный номер тикета.');
                // Открыть переписку может только участник этого тикета
                const ticket = await getTicketIfParticipant(ticketId, senderId);
                if (!ticket) {
                    console.warn(`[SECURITY] Отказ open_chat: ${senderId} не участник тикета ${ticketId} — возможна подделка кнопки`);
                    return context.send('Тикет не найден или недоступен.');
                }
                await db.query("UPDATE users SET current_chat_ticket_id = $1, state = 'chat_mode' WHERE vk_id = $2", [ticketId, senderId]);
                console.info(`[TICKET] ${senderId} открыл чат тикета #${ticketId}`);
                const userRes = await db.query('SELECT role FROM users WHERE vk_id = $1', [senderId]);
                const kb = userRes.rows[0].role === 'operator' ? Keyboard.builder().textButton({ label: '🏁 Завершить этот тикет', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '⬅️ Назад к списку', color: Keyboard.SECONDARY_COLOR }) : Keyboard.builder().textButton({ label: '🏁 Завершить вопрос', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '⬅️ В меню', color: Keyboard.SECONDARY_COLOR });
                await context.send({ message: `🟢 Чат #${ticketId} активен.`, keyboard: kb });
                const msgs = await db.query(`SELECT * FROM messages WHERE ticket_id = $1 AND sender_vk_id != $2 AND is_read = FALSE ORDER BY created_at ASC`, [ticketId, senderId]);
                if (msgs.rows.length > 0) {
                    await context.send(`📥 Новые сообщения:`);
                    for (let m of msgs.rows) await context.send({ message: m.text || '', attachment: m.attachments ? m.attachments.join(',') : '' });
                    await db.query(`UPDATE messages SET is_read = TRUE WHERE ticket_id = $1 AND sender_vk_id != $2`, [ticketId, senderId]);
                }
                return;
            }
            if (messagePayload.command === 'manage_ticket') {
                const ticketId = parseId(messagePayload.ticket_id);
                if (!ticketId) return context.send('Некорректный номер тикета.');
                // Управлять заявкой может только её автор и только пока её не взяли в работу
                const own = await db.query(
                    "SELECT id FROM tickets WHERE id = $1 AND student_vk_id = $2 AND status = 'open'",
                    [ticketId, senderId]
                );
                if (own.rows.length === 0) {
                    console.warn(`[SECURITY] Отказ manage_ticket: ${senderId} не автор тикета ${ticketId} (или тикет уже в работе)`);
                    return context.send('Заявка не найдена или её уже взяли в работу.');
                }
                await db.query("UPDATE users SET state = 'ticket_manage_menu', current_chat_ticket_id = $1 WHERE vk_id = $2", [ticketId, senderId]);
                await context.send({ message: `📝 Управление #${ticketId}`, keyboard: Keyboard.builder().textButton({ label: '✏️ Изменить текст', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '❌ Удалить заявку', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }) });
                return;
            }
            if (messagePayload.command === 'confirm_send' || messagePayload.command === 'operator_request') {
                const userRes = await db.query('SELECT group_number, full_name, ai_context, pending_attachments FROM users WHERE vk_id = $1', [senderId]);
                const user = userRes.rows[0];

                let qText = messagePayload.question || text || "Вопрос из AI диалога";

                // Если вопрос не влез в payload (лимит 255), берем последнее сообщение из контекста
                if (messagePayload.command === 'operator_request' && !messagePayload.question && user.ai_context) {
                    const lastUserMsg = [...user.ai_context].reverse().find(m => m.role === 'user');
                    if (lastUserMsg) qText = lastUserMsg.content;
                }

                // Достаём временно сохранённые вложения (фото) и очищаем их
                const pendingAtts = user.pending_attachments || [];
                await db.query("UPDATE users SET state = 'main_menu', pending_attachments = NULL WHERE vk_id = $1", [senderId]);

                const newT = await db.query("INSERT INTO tickets (student_vk_id, question) VALUES ($1, $2) RETURNING id", [senderId, qText]);
                const ticketId = newT.rows[0].id;
                console.info(`[TICKET] Создан тикет #${ticketId} от ${senderId} (${messagePayload.command === 'operator_request' ? 'из диалога с ИИ' : 'из поиска'}): «${preview(qText, 120)}»${pendingAtts.length ? `, фото: ${pendingAtts.length}` : ''}`);
                await context.send({ message: `✅ Вопрос отправлен администратору.`, keyboard: Keyboard.builder().textButton({ label: '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                const ops = await db.query(`SELECT vk_id FROM users WHERE role = 'operator'`);
                const attStr = pendingAtts.join(',');
                const photoNote = pendingAtts.length > 0 ? `\n📎 Прикреплено фото: ${pendingAtts.length} шт.` : '';

                // Раньше ошибки отправки глотались пустым catch: если ни один
                // администратор не получил уведомление, об этом никто не узнавал
                let delivered = 0;
                for (let op of ops.rows) {
                    const ok = await notify(vk, op.vk_id, {
                        message: `🆘 Новый вопрос #${ticketId} от ${user.full_name}:\n"${qText}"${photoNote}`,
                        attachment: attStr || undefined,
                        keyboard: Keyboard.builder().textButton({ label: `Взять #${ticketId}`, payload: { command: 'take_ticket', ticket_id: ticketId }, color: Keyboard.POSITIVE_COLOR }).inline()
                    }, `уведомление о тикете #${ticketId}`);
                    if (ok) delivered++;
                }
                if (ops.rows.length === 0) {
                    console.warn(`[TICKET] Тикет #${ticketId}: в системе нет ни одного администратора — уведомлять некого`);
                } else if (delivered === 0) {
                    console.error(`[TICKET] Тикет #${ticketId}: уведомление не доставлено НИ ОДНОМУ из ${ops.rows.length} администраторов`);
                } else {
                    console.info(`[TICKET] Тикет #${ticketId}: администраторов уведомлено ${delivered} из ${ops.rows.length}`);
                }
                return;
            }
            if (messagePayload.command === 'ask_ai') {
                const uRes = await db.query('SELECT * FROM users WHERE vk_id = $1', [senderId]);
                const localUser = uRes.rows[0];
                if (!localUser) return;

                const qText = messagePayload.question || text || "Вопрос для ИИ";
                console.info(`[BOT] ${senderId} нажал «Спросить ИИ» для вопроса «${preview(qText, 120)}»`);
                try {
                    const faqHints = await buildDialogHints(qText, await searchFaq(qText, 8), localUser.ai_context);
                    await enqueueAiTask(context, localUser, qText, faqHints, groupId);
                } catch (e) {
                    console.error('[SEARCH] Ошибка поиска для кнопки ИИ:', e.message);
                    await enqueueAiTask(context, localUser, qText, '', groupId);
                }
                return;
            }
        }

        // 2. ПОЛУЧЕНИЕ ЮЗЕРА
        let userRes = await db.query('SELECT * FROM users WHERE vk_id = $1', [senderId]);
        let user = userRes.rows[0];
        if (!user) {
            await db.query('INSERT INTO users (vk_id, state) VALUES ($1, $2)', [senderId, 'registration_start']);
            console.info(`[BOT] Новый пользователь ${senderId} (группа ${groupId}) — начата регистрация`);
            await context.send({ message: 'Добро пожаловать! Кто вы?', keyboard: Keyboard.builder().textButton({ label: 'Я Студент', payload: { command: 'student' }, color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Я Администратор', payload: { command: 'operator' }, color: Keyboard.POSITIVE_COLOR }).oneTime() });
            return;
        }

        // 2.5. Сверка курса студента с его сообществом. Сбой здесь не должен
        // мешать ответу на само сообщение — поэтому отдельный обработчик ошибок.
        try {
            user = await reconcileStudentCourse(context, user, groupId);
        } catch (err) {
            console.error(`[COURSE] Не удалось сверить курс ${senderId}:`, err);
        }

        // 3. МАШИНА СОСТОЯНИЙ
        await processState(context, user, vk, groupId);

    } catch (err) {
        // Раньше здесь был console.error(err) — в логе оставался огромный дамп
        // объекта или «{}». Теперь: кто, что прислал, текст ошибки; стек — в файле лога.
        console.error(`[BOT] Ошибка обработки сообщения от ${senderId} (${describeIncoming(context)}):`, err);
    }
}

// Обработка состояний
async function processState(context, user, vk, groupId) {
    const { text, senderId, attachments, messagePayload } = context;

    // Состояние, в котором обрабатывается сообщение. По последовательности
    // этих строк в логе видно, как пользователь двигался по диалогу.
    console.debug(`[FSM] ${senderId} (${user.role || 'без роли'}): состояние «${user.state}»`);

    switch (user.state) {
        case 'chat_mode':
            if (!user.current_chat_ticket_id) { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); return context.send('Ошибка. В меню.'); }
            if (text === '⬅️ Назад к списку' || text === '⬅️ В меню') { await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); return mainMenu(context, user); }
            if (text === '🏁 Завершить этот тикет' || text === '🏁 Завершить вопрос') {
                await db.query("UPDATE tickets SET status = 'closed' WHERE id = $1", [user.current_chat_ticket_id]);
                const t = (await db.query('SELECT * FROM tickets WHERE id = $1', [user.current_chat_ticket_id])).rows[0];
                const targetId = (user.role === 'operator') ? t.student_vk_id : t.operator_vk_id;
                console.info(`[TICKET] Тикет #${t.id} закрыт ${user.role === 'operator' ? 'администратором' : 'студентом'} ${senderId}`);
                if (targetId) {
                    await notify(vk, targetId, { message: `🏁 Тикет #${t.id} завершен.` }, `уведомление о закрытии тикета #${t.id}`);
                    await db.query("UPDATE users SET current_chat_ticket_id = NULL, state = 'main_menu' WHERE vk_id = $1 AND current_chat_ticket_id = $2", [targetId, t.id]);
                }
                await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]);
                await context.send('Тикет закрыт.');
                return mainMenu(context, user);
            }
            const activeT = (await db.query('SELECT * FROM tickets WHERE id = $1', [user.current_chat_ticket_id])).rows[0];
            if (!activeT || activeT.status === 'closed') { await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); return context.send('Тикет закрыт.'); }
            const recId = (user.role === 'operator') ? activeT.student_vk_id : activeT.operator_vk_id;
            if (recId) {
                const atts = resolveAttachments(attachments);
                await db.query(`INSERT INTO messages (ticket_id, sender_vk_id, text, attachments, is_read) VALUES ($1, $2, $3, $4, FALSE)`, [user.current_chat_ticket_id, senderId, text || '', atts]);
                const recUser = (await db.query('SELECT current_chat_ticket_id FROM users WHERE vk_id = $1', [recId])).rows[0];
                if (recUser && recUser.current_chat_ticket_id === activeT.id) {
                    // Собеседник сейчас в этом чате — пересылаем сразу. Прочитанным
                    // сообщение отмечаем, только если пересылка удалась: раньше ошибка
                    // глоталась, и сообщение молча терялось.
                    const ok = await notify(vk, recId, { message: text || '', attachment: atts.join(',') }, `пересылка в чате тикета #${activeT.id}`);
                    if (ok) {
                        await db.query(`UPDATE messages SET is_read = TRUE WHERE ticket_id = $1 AND sender_vk_id = $2`, [activeT.id, senderId]);
                        console.debug(`[TICKET] #${activeT.id}: сообщение ${senderId} → ${recId} доставлено${atts.length ? `, вложений: ${atts.length}` : ''}`);
                    }
                } else {
                    const unread = parseInt((await db.query(`SELECT COUNT(*) FROM messages WHERE ticket_id = $1 AND sender_vk_id = $2 AND is_read = FALSE`, [activeT.id, senderId])).rows[0].count);
                    console.debug(`[TICKET] #${activeT.id}: ${recId} не в чате, сообщение сохранено (непрочитанных: ${unread})`);
                    if (unread === 1) {
                        const info = (user.role === 'student') ? `👤 ${user.full_name}` : '👨‍💻 Администратор';
                        await notify(vk, recId, { message: `🔔 Новое от ${info} (#${activeT.id})`, keyboard: Keyboard.builder().textButton({ label: `Подключиться к #${activeT.id}`, payload: { command: 'open_chat', ticket_id: activeT.id }, color: Keyboard.POSITIVE_COLOR }).inline() }, `оповещение о новом сообщении в тикете #${activeT.id}`);
                    }
                }
            } else {
                console.warn(`[TICKET] #${activeT.id}: сообщение от ${senderId} некому доставить — у тикета нет второй стороны`);
            }
            break;

        case 'ask_question_mode':
            // 0. Навигация
            if (text === '🏠 В меню' || text === '🔙 Назад' || ['✉️ Задать вопрос', '👤 Профиль', '🗂 Мои обращения'].includes(text) || text === '🏠 В меню (отменить)') {
                if (text === '🏠 В меню (отменить)') {
                    const cancelled = await db.query("DELETE FROM ai_queue WHERE vk_id = $1 AND status IN ('pending', 'processing') RETURNING id", [senderId]);
                    console.info(`[QUEUE] ${senderId} отменил вопрос к ИИ (снято задач: ${cancelled.rowCount})`);
                }
                await db.query("UPDATE users SET state = 'main_menu', pending_attachments = NULL WHERE vk_id = $1", [senderId]);
                return mainMenu(context, user);
            }

            // 0.5. Обработка фото
            const photoAtts = attachments.filter(a => a.type === 'photo');
            if (photoAtts.length > 0) {
                const attStrings = resolveAttachments(photoAtts);
                await db.query('UPDATE users SET pending_attachments = $1 WHERE vk_id = $2', [JSON.stringify(attStrings), senderId]);
                console.info(`[BOT] ${senderId}: сохранено фото для будущего обращения — ${photoAtts.length} шт.${text ? '' : ' (без текста, ждём вопрос)'}`);

                // Если фото без текста — предупреждаем и ждём текстовый вопрос
                if (!text) {
                    await context.send({
                        message: `📷 Я получил ${photoAtts.length} фото, но не умею анализировать изображения.\n\nВведите ваш вопрос текстом — и фото будут автоматически приложены к нему, если вы решите передать вопрос тьютору.`,
                        keyboard: Keyboard.builder()
                            .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                    return;
                } else {
                    // Если фото с текстом — предупреждаем, что анализируем только текст
                    await context.send(`📷 Я сохранил прикрепленные фото (${photoAtts.length} шт.), но сейчас я проанализирую только ваш текст.\nЕсли мой ответ не поможет, вы сможете передать вопрос тьютору вместе с этими фото.`);
                }
            }

            const safeText = text || '';

            // 1. ЕДИНЫЙ ПОИСК (лексика + нечёткий) — см. faq_search.js
            // Сам запрос и вклад лексики/триграмм пишет searchFaq (уровень DEBUG)
            try {
                const rows = await searchFaq(safeText, 8);

                // Уверенные совпадения показываем сразу, без ИИ
                const hits = rows.filter(r => r.score > DIRECT_MIN_SCORE);

                if (hits.length > 0) {
                    const best = hits[0];

                    // Если один явный лидер (или всего один результат) -> Показываем сразу ответ
                    // Условие лидера: его счет в 1.5 раза больше второго места
                    const isLeader = hits.length === 1 || (hits[1] && best.score > hits[1].score * 1.5);

                    if (isLeader) {
                        const why = hits.length === 1 ? 'единственное уверенное совпадение' : `в ${(best.score / hits[1].score).toFixed(1)} раза выше второго`;
                        console.info(`[SEARCH] Решение для ${senderId}: ответ из базы — FAQ #${best.id} «${preview(best.question, 80)}», score ${best.score.toFixed(3)} (${why})`);
                        await context.send({
                            message: `📚 ${best.question}\n\n${best.answer}`,
                            keyboard: Keyboard.builder()
                                .textButton({ label: '✉️ Передать администратору', payload: { command: 'confirm_send', question: safeText }, color: Keyboard.POSITIVE_COLOR })
                                .row()
                                .textButton({ label: '🤖 Спросить ИИ-ассистента', payload: { command: 'ask_ai', question: safeText }, color: Keyboard.PRIMARY_COLOR })
                                .row()
                                .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR })
                                .oneTime()
                        });
                        return;
                    }

                    // Иначе предлагаем варианты (до 5 кнопок). Раньше срез забыли, и при
                    // 8 совпадениях вместе с тремя служебными кнопками клавиатура могла
                    // превысить лимит строк VK — сообщение не отправлялось вовсе.
                    const options = hits.slice(0, 5);
                    console.info(`[SEARCH] Решение для ${senderId}: явного лидера нет — предложено вариантов ${options.length}: ${options.map(r => `#${r.id} (${r.score.toFixed(3)})`).join(', ')}`);
                    let kb = Keyboard.builder();
                    options.forEach((r, i) => {
                        kb.textButton({
                            label: `${i + 1}. ${r.question.substring(0, 30).replace(/\n/g, ' ')}...`,
                            payload: { command: 'show_faq_answer', faq_id: r.id },
                            color: Keyboard.PRIMARY_COLOR
                        }).row();
                    });

                    kb.textButton({ label: '✉️ Передать администратору', payload: { command: 'confirm_send', question: safeText }, color: Keyboard.POSITIVE_COLOR })
                        .row()
                        .textButton({ label: '🤖 Спросить ИИ-ассистента', payload: { command: 'ask_ai', question: safeText }, color: Keyboard.PRIMARY_COLOR })
                        .row()
                        .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR });

                    await context.send({
                        message: '🔎 Нашел несколько вариантов:',
                        keyboard: kb.oneTime()
                    });
                    return;
                }

                // Уверенного ответа нет — передаём ИИ как контекст только записи выше
                // порога. Шум ниже порога не передаём: на нём модель и выдумывала факты.
                // Для уточняющего вопроса в диалоге ищем ещё и по предыдущему вопросу
                const faqHints = await buildDialogHints(safeText, rows, user.ai_context);
                const hintCount = faqHints ? faqHints.split('\n---\n').length : 0;

                console.info(`[SEARCH] Решение для ${senderId}: уверенного ответа в базе нет (лучший score ${rows[0] ? rows[0].score.toFixed(3) : '—'}) → вопрос уходит ИИ, ${hintCount > 0 ? `подсказок из базы: ${hintCount}` : 'без контекста — все совпадения ниже порога'}`);
                await enqueueAiTask(context, user, text, faqHints, groupId);
            } catch (err) {
                console.error(`[SEARCH] Ошибка поиска для ${senderId}, вопрос уходит ИИ без контекста:`, err);
                await enqueueAiTask(context, user, text, '', groupId);
            }
            break;

        case 'ai_dialogue_mode':
            if (text === '🏠 В меню' || text === '🔙 Назад' || ['✉️ Задать вопрос', '👤 Профиль', '🗂 Мои обращения'].includes(text) || text === '🏠 В меню (отменить)') {
                if (text === '🏠 В меню (отменить)') {
                    await db.query("DELETE FROM ai_queue WHERE vk_id = $1 AND status IN ('pending', 'processing')", [senderId]);
                }
                await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                return mainMenu(context, user);
            }

            // Защита от спама: если есть pending или processing задача
            const inQueueRes = await db.query("SELECT id FROM ai_queue WHERE vk_id = $1 AND status IN ('pending', 'processing')", [senderId]);
            if (inQueueRes.rows.length > 0) {
                console.info(`[QUEUE] ${senderId}: сообщение во время ожидания ответа ИИ — попросили дождаться (задача ${inQueueRes.rows[0].id})`);
                return context.send({ message: '⏳ Пожалуйста, дождитесь ответа на ваш предыдущий вопрос.', keyboard: Keyboard.builder().textButton({ label: '🏠 В меню (отменить)', color: Keyboard.SECONDARY_COLOR }).oneTime() });
            }

            await enqueueAiTask(context, user, text, '', groupId);
            break;

        case 'main_menu':
            if (user.role === 'operator') {
                if (text === '📥 Очередь вопросов') {
                    const q = await db.query(`SELECT t.id, t.question, u.full_name, u.group_number FROM tickets t JOIN users u ON t.student_vk_id = u.vk_id WHERE t.status = 'open' ORDER BY t.created_at ASC LIMIT 5`);
                    if (q.rows.length === 0) { await context.send('Очередь пуста 🎉'); await mainMenu(context, user); }
                    else {
                        let msg = '📥 Очередь:\n'; let kb = Keyboard.builder();
                        q.rows.forEach(t => { msg += `\n🆔 #${t.id} [${t.full_name} ${t.group_number}]: ${t.question}`; kb.textButton({ label: `Взять #${t.id}`, payload: { command: 'take_ticket', ticket_id: t.id }, color: Keyboard.POSITIVE_COLOR }).row(); });
                        await context.send({ message: msg, keyboard: kb.inline() }); await mainMenu(context, user);
                    }
                } else if (text === '💬 Мои диалоги') {
                    const q = await db.query(`SELECT t.id, t.question, u.full_name FROM tickets t JOIN users u ON t.student_vk_id = u.vk_id WHERE t.status = 'active' AND t.operator_vk_id = $1`, [senderId]);
                    if (q.rows.length === 0) { await context.send('Нет активных диалогов.'); await mainMenu(context, user); }
                    else {
                        let msg = '💬 Диалоги:\n'; let kb = Keyboard.builder();
                        q.rows.forEach(t => { msg += `\n🆔 #${t.id} [${t.full_name}]: ${t.question}`; kb.textButton({ label: `Перейти к #${t.id}`, payload: { command: 'open_chat', ticket_id: t.id }, color: Keyboard.PRIMARY_COLOR }).row(); });
                        await context.send({ message: msg, keyboard: kb.inline() }); await mainMenu(context, user);
                    }
                } else if (text === '👤 Профиль') {
                    await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);
                    await context.send({ message: `👤 Администратор: ${user.full_name}`, keyboard: Keyboard.builder().textButton({ label: '✏️ Редактировать', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🚪 Выйти из аккаунта', payload: { command: 'logout' }, color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🏠 Главное меню', color: Keyboard.SECONDARY_COLOR }) });
                } else if (text === '⚠️ Жалоба / Отзыв') {
                    await db.query("UPDATE users SET state = 'feedback_mode' WHERE vk_id = $1", [senderId]);
                    await context.send({ message: 'Напишите вашу жалобу или отзыв о работе бота. Разработчик обязательно прочитает!', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                } else { await mainMenu(context, user); }
            } else {
                if (text === '✉️ Задать вопрос') { await db.query("UPDATE users SET state = 'ask_question_mode', ai_context = '[]' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Напишите вопрос:', keyboard: Keyboard.builder().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                else if (text === '🗂 Мои обращения') {
                    const q = await db.query(`SELECT id, question, status FROM tickets WHERE student_vk_id = $1 ORDER BY created_at DESC LIMIT 5`, [senderId]);
                    if (q.rows.length === 0) { await context.send('Нет обращений.'); await mainMenu(context, user); }
                    else {
                        let msg = '🗂 Ваши обращения:\n'; let kb = Keyboard.builder();
                        q.rows.forEach(t => {
                            const st = (t.status === 'open' ? '⏳' : (t.status === 'active' ? '🟢' : '🏁'));
                            msg += `\n#${t.id}: ${st}\n❓ ${t.question}`;
                            if (t.status === 'active') kb.textButton({ label: `Перейти к #${t.id}`, payload: { command: 'open_chat', ticket_id: t.id }, color: Keyboard.POSITIVE_COLOR }).row();
                            else if (t.status === 'open') kb.textButton({ label: `✏️ Упр. #${t.id}`, payload: { command: 'manage_ticket', ticket_id: t.id }, color: Keyboard.SECONDARY_COLOR }).row();
                        });
                        await context.send({ message: msg, keyboard: kb.inline() }); await mainMenu(context, user);
                    }
                } else if (text === '👤 Профиль') {
                    await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);
                    await context.send({ message: `👤 Студент: ${user.full_name}\nГруппа: ${user.group_number}`, keyboard: Keyboard.builder().textButton({ label: '✏️ Редактировать', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '❌ Удалить профиль', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🏠 Главное меню', color: Keyboard.SECONDARY_COLOR }) });
                } else if (text === '⚠️ Жалоба / Отзыв') {
                    await db.query("UPDATE users SET state = 'feedback_mode' WHERE vk_id = $1", [senderId]);
                    await context.send({ message: 'Напишите вашу жалобу или отзыв о работе бота. Разработчик обязательно прочитает!', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                } else { await mainMenu(context, user); }
            }
            break;

        case 'feedback_mode':
            if (text === '🔙 Назад' || text === '🏠 В меню') {
                await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                return mainMenu(context, user);
            }
            // Фото без подписи: text пустой, и text.length раньше падал с TypeError —
            // студент не получал ответа вовсе
            if (!text) return context.send('Пожалуйста, напишите отзыв текстом — фотографии в отзывах пока не принимаются.');
            if (text.length > 2000) return context.send('Текст слишком длинный.');
            await db.query("INSERT INTO feedback (vk_id, text) VALUES ($1, $2)", [senderId, text]);
            console.info(`[BOT] ${senderId} оставил отзыв: «${preview(text, 150)}»`);
            await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
            await context.send('✅ Спасибо за обратную связь! Разработчик ознакомится с вашим сообщением.');
            await mainMenu(context, user);
            break;

        case 'registration_start': if (text === 'Я Студент') { await db.query("UPDATE users SET state = 'reg_student_fio' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Введите ФИО:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } else if (text === 'Я Администратор') { await db.query("UPDATE users SET state = 'reg_operator_code' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Введите код:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } break;
        case 'reg_student_fio': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'registration_start' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Кто вы?', keyboard: Keyboard.builder().textButton({ label: 'Я Студент', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Я Администратор', color: Keyboard.POSITIVE_COLOR }).oneTime() }); } if (text.length > 100) return context.send('ФИО слишком длинное.'); if (!REGEX_FIO.test(text)) return context.send('Ошибка ФИО'); await db.query("UPDATE users SET full_name = $1, state = 'reg_student_group' WHERE vk_id = $2", [text, senderId]); await context.send({ message: 'Группа:(РИ-XXXXXX)', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); break;
        case 'reg_student_group': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'reg_student_fio' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Введите ФИО:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } const g = (text || '').toUpperCase(); if (g.length > 20 || !REGEX_GROUP.test(g)) return context.send('Не похоже на номер группы. Нужен формат РИ-240944: буквы, дефис и шесть цифр, первая цифра — номер курса.'); const courseMismatch = await checkGroupAgainstCommunity(g, groupId); if (courseMismatch) { console.info(`[COURSE] ${senderId}: при регистрации указана группа ${g}, не совпадающая с курсом сообщества ${groupId}`); return context.send(courseMismatch); } /* Сообщество запоминаем сразу при регистрации: по нему потом переводится курс */ await db.query("UPDATE users SET group_number = $1, study_years = 4, role = 'student', state = 'main_menu', vk_group_id = $3 WHERE vk_id = $2", [g, senderId, groupId]); console.info(`[BOT] ${senderId}: регистрация студента завершена (группа ${g})`); await context.send('✅ Регистрация успешно завершена!'); await mainMenu(context, { ...user, role: 'student' }); break;
        case 'reg_operator_code': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'registration_start' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Кто вы?', keyboard: Keyboard.builder().textButton({ label: 'Я Студент', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Я Администратор', color: Keyboard.POSITIVE_COLOR }).oneTime() }); } const cRes = await db.query('SELECT * FROM operator_codes WHERE code = $1', [text]); if (cRes.rows.length > 0) { await db.query("UPDATE users SET role = 'operator', full_name = $1, linked_code = $2, state = 'main_menu' WHERE vk_id = $3", [cRes.rows[0].admin_name, text, senderId]); console.info(`[SECURITY] ${senderId} вошёл как администратор (${cRes.rows[0].admin_name})`); await context.send('Успех!'); await mainMenu(context, { ...user, role: 'operator' }); } else { console.warn(`[SECURITY] ${senderId}: неверный код администратора — попытка входа`); await context.send({ message: 'Неверный код', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } break;
        case 'profile_view': if (text === '✏️ Редактировать') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); const editKb = Keyboard.builder().textButton({ label: 'ФИО', color: Keyboard.PRIMARY_COLOR }); if (user.role === 'student') { editKb.textButton({ label: 'Группу', color: Keyboard.PRIMARY_COLOR }); } editKb.row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }); await context.send({ message: 'Что изменить?', keyboard: editKb.oneTime() }); } else if (text === '❌ Удалить профиль') { await db.query("UPDATE users SET state = 'profile_delete_confirm' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Удалить?', keyboard: Keyboard.builder().textButton({ label: 'Да', color: Keyboard.NEGATIVE_COLOR }).textButton({ label: 'Нет', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } else { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await mainMenu(context, user); } break;
        case 'profile_edit_select': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await mainMenu(context, user); return; } if (text === 'ФИО') { const s = user.role === 'operator' ? 'edit_tutor_fio' : 'edit_student_fio'; await db.query("UPDATE users SET state = $1 WHERE vk_id = $2", [s, senderId]); await context.send({ message: 'Новое ФИО:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } else if (text === 'Группу' && user.role === 'student') { await db.query("UPDATE users SET state = 'edit_student_group' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Новая группа:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } break;
        case 'edit_student_fio': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send('Что изменить?'); } if (!REGEX_FIO.test(text)) return context.send('Ошибка ФИО'); await db.query("UPDATE users SET full_name = $1, state = 'main_menu' WHERE vk_id = $2", [text, senderId]); await context.send('Обновлено!'); await mainMenu(context, user); break;
        case 'edit_student_group': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send('Что изменить?'); } const g2 = (text || '').toUpperCase(); if (!REGEX_GROUP.test(g2)) return context.send('Не похоже на номер группы. Нужен формат РИ-240944: буквы, дефис и шесть цифр, первая цифра — номер курса.'); const courseMismatch2 = await checkGroupAgainstCommunity(g2, user.vk_group_id || groupId); if (courseMismatch2) { console.info(`[COURSE] ${senderId}: при смене группы указана ${g2}, не совпадающая с курсом сообщества`); return context.send(courseMismatch2); } console.info(`[BOT] ${senderId} сменил группу: ${user.group_number} → ${g2}`); await db.query("UPDATE users SET group_number = $1, state = 'main_menu' WHERE vk_id = $2", [g2, senderId]); await context.send('Обновлено!'); await mainMenu(context, user); break;
        case 'edit_tutor_fio': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send('Что изменить?'); } if (!REGEX_FIO.test(text)) return context.send('Ошибка ФИО'); await db.query("UPDATE users SET full_name = $1 WHERE vk_id = $2", [text, senderId]); await db.query("UPDATE operator_codes SET admin_name = $1 WHERE code = $2", [text, user.linked_code]); await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await context.send('Обновлено!'); await mainMenu(context, user); break;

        case 'profile_delete_confirm': if (text === 'Да') { await db.query('DELETE FROM users WHERE vk_id = $1', [senderId]); console.info(`[BOT] ${senderId} удалил свой профиль`); await context.send({ message: 'Профиль удален!' }); } else { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await mainMenu(context, user); } break;
        case 'ticket_manage_menu': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); return mainMenu(context, user); } if (text === '❌ Удалить заявку') { await db.query("DELETE FROM tickets WHERE id = $1 AND student_vk_id = $2", [user.current_chat_ticket_id, senderId]); console.info(`[TICKET] ${senderId} удалил свою заявку #${user.current_chat_ticket_id}`); await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); await context.send('Удалено.'); return mainMenu(context, user); } if (text === '✏️ Изменить текст') { await db.query("UPDATE users SET state = 'ticket_edit_text' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Новый текст:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } break;
        case 'ticket_edit_text': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'ticket_manage_menu' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Меню:', keyboard: Keyboard.builder().textButton({ label: '✏️', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '❌', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🔙', color: Keyboard.SECONDARY_COLOR }) }); } await db.query("UPDATE tickets SET question = $1 WHERE id = $2 AND student_vk_id = $3", [text, user.current_chat_ticket_id, senderId]); console.info(`[TICKET] ${senderId} изменил текст заявки #${user.current_chat_ticket_id}`); await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); await context.send('Обновлено!'); return mainMenu(context, user); break;
    }
}

async function mainMenu(context, user) {
    if (user.role === 'operator') {
        await context.send({
            message: 'Меню администратора:',
            keyboard: Keyboard.builder().textButton({ label: '📥 Очередь вопросов', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '💬 Мои диалоги', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR }).textButton({ label: '⚠️ Жалоба / Отзыв', color: Keyboard.SECONDARY_COLOR })
        });
    } else {
        await context.send({
            message: 'Меню студента:',
            keyboard: Keyboard.builder().textButton({ label: '✉️ Задать вопрос', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR }).textButton({ label: '⚠️ Жалоба / Отзыв', color: Keyboard.SECONDARY_COLOR })
        });
    }
}

/** Человекочитаемая оценка ожидания */
function formatWait(seconds) {
    if (seconds < 60) return `~${Math.max(5, Math.round(seconds / 5) * 5)} сек`;
    return `~${Math.ceil(seconds / 60)} мин`;
}

async function enqueueAiTask(context, user, question, faqContextText, groupId) {
    const senderId = user.vk_id;
    try {
        // Защита от спама на ВСЕХ путях постановки задачи.
        // Раньше проверка жила только в состоянии ai_dialogue_mode, а кнопка
        // «Спросить ИИ» обрабатывается до машины состояний и её обходила —
        // повторными нажатиями один человек забивал очередь до Circuit Breaker.
        const inQueue = await db.query(
            "SELECT id FROM ai_queue WHERE vk_id = $1 AND status IN ('pending', 'processing')",
            [senderId]
        );
        if (inQueue.rows.length > 0) {
            console.info(`[QUEUE] ${senderId}: новый вопрос отклонён — предыдущий ещё в очереди (задача ${inQueue.rows[0].id})`);
            return context.send({
                message: '⏳ Пожалуйста, дождитесь ответа на ваш предыдущий вопрос.',
                keyboard: Keyboard.builder().textButton({ label: '🏠 В меню (отменить)', color: Keyboard.SECONDARY_COLOR }).oneTime()
            });
        }

        const countRes = await db.query("SELECT COUNT(*) FROM ai_queue WHERE status = 'pending'");
        const pendingCount = parseInt(countRes.rows[0].count);

        if (pendingCount >= 50) {
            console.warn(`[QUEUE] Circuit Breaker: в очереди ${pendingCount} задач — вопрос ${senderId} не принят, предложено передать администратору`);
            await context.send({
                message: '⚠️ Сейчас ИИ-ассистент испытывает экстремальную нагрузку. Пожалуйста, передайте вопрос администраторам.',
                keyboard: Keyboard.builder()
                    .textButton({ label: '✉️ Передать администратору', payload: { command: 'confirm_send', question: question }, color: Keyboard.POSITIVE_COLOR })
                    .row()
                    .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR })
                    .oneTime()
            });
            return;
        }

        // Оценка по фактической скорости последних ответов, а не по константе
        // «10 ответов в минуту». Считаем последовательно: у GigaChat для
        // физлиц доступен всего один поток.
        const { avgSeconds } = getQueueStats();
        let waitMsg = '🧠 Ваш вопрос передан ИИ-ассистенту.';
        if (pendingCount > 0) {
            waitMsg += `\nПеред вами в очереди: ${pendingCount}. Примерное время ответа: ${formatWait((pendingCount + 1) * avgSeconds)}.`;
        }

        await context.send({
            message: waitMsg,
            keyboard: Keyboard.builder().textButton({ label: '🏠 В меню (отменить)', color: Keyboard.SECONDARY_COLOR }).oneTime()
        });

        let aiCtx = user.ai_context || [];
        aiCtx.push({ role: 'user', content: question });

        // Ограничиваем историю диалога последними 5-ю парами вопрос-ответ (10 сообщений), чтобы не переполнять контекст
        if (aiCtx.length > 10) {
            aiCtx = aiCtx.slice(aiCtx.length - 10);
        }

        // vk_group_id пользователя здесь больше не перезаписываем: это его курсовое
        // сообщество, по нему переводится курс. Вопрос из чужого сообщества сменил бы
        // его «прописку». Боту для ответа хватает vk_group_id в самой задаче очереди.
        await db.query("UPDATE users SET state = 'ai_dialogue_mode', ai_context = $1 WHERE vk_id = $2", [JSON.stringify(aiCtx), senderId]);

        const queued = await db.query(
            "INSERT INTO ai_queue (vk_id, vk_group_id, ai_context, faq_context) VALUES ($1, $2, $3, $4) RETURNING id",
            [senderId, groupId, JSON.stringify(aiCtx), faqContextText || '']
        );
        console.info(`[QUEUE] Задача ${queued.rows[0].id} от ${senderId} поставлена в очередь (перед ней: ${pendingCount}, история диалога: ${aiCtx.length} сообщ., контекст из базы: ${faqContextText ? 'есть' : 'нет'})`);

    } catch (err) {
        console.error(`[QUEUE] Не удалось поставить вопрос ${senderId} в очередь ИИ:`, err);
    }
}

// Экспорт фабричной функции
module.exports = createBotInstance;
module.exports.isGroupAllowed = isGroupAllowed;
module.exports.getAllowedGroupIds = getAllowedGroupIds;
// Для тестов: обработчик сообщений без подключения к VK
module.exports._test = { handleMessage, instrumentSend, reconcileStudentCourse, checkGroupAgainstCommunity };