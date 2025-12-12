require('dotenv').config();
const { VK, Keyboard } = require('vk-io');
const { Client } = require('pg');

const vk = new VK({
    token: process.env.VK_TOKEN
});

const db = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

// Логи без эмодзи (Clean Logs)
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

// Regex
const REGEX_FIO = /^[А-Яа-яЁё]+\s+[А-Яа-яЁё]+.*$/;
const REGEX_GROUP = /^[А-Я]{2,}-\d{6}$/;

// Хелперы
const getStatusText = (status) => {
    switch (status) {
        case 'open': return 'В ожидании';
        case 'active': return 'Активен';
        case 'closed': return 'Завершен';
        default: return status;
    }
};

const resolveAttachments = (attachments) => {
    if (!attachments) return [];
    return attachments.map(att => `${att.type}${att.ownerId}_${att.id}${att.accessKey ? '_' + att.accessKey : ''}`);
};

// Функция для получения вектора (Ollama)
async function getEmbedding(text) {
    try {
        const response = await fetch('http://127.0.0.1:11434/api/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'nomic-embed-text',
                prompt: text
            })
        });
        const data = await response.json();
        return data.embedding;
    } catch (e) {
        console.error('Ollama error:', e.message);
        return null;
    }
}

vk.updates.on('message_new', async (context) => {
    if (context.isOutbox) return;
    const { text, senderId, messagePayload, attachments } = context;

    if (!text && !messagePayload && attachments.length === 0) return;

    try {
        const msgText = text || (attachments.length > 0 ? '[Вложение]' : '[Кнопка]');
        log(`Message from ${senderId}: "${msgText}"`);

        // =========================================================
        // 1. ОБРАБОТКА КНОПОК (PAYLOAD)
        // =========================================================
        if (messagePayload) {

            // --- ТЬЮТОР: ВЫХОД (LOGOUT) ---
            if (messagePayload.command === 'logout') {
                await db.query('DELETE FROM users WHERE vk_id = $1', [senderId]);
                return context.send({
                    message: 'Вы вышли из системы. Для начала работы напишите любое сообщение.',
                    keyboard: Keyboard.builder().initial(false)
                });
            }

            // --- ОБЩЕЕ: ПОКАЗАТЬ КОНКРЕТНЫЙ ОТВЕТ ИЗ СПИСКА УТОЧНЕНИЙ ---
            if (messagePayload.command === 'show_faq_answer') {
                const faqId = messagePayload.faq_id;
                // Ищем ответ в базе
                const faqRes = await db.query('SELECT question, answer FROM faq WHERE id = $1', [faqId]);

                if (faqRes.rows.length > 0) {
                    const row = faqRes.rows[0];
                    await context.send({
                        message: `📚 ${row.question}\n\n${row.answer}`,
                        // ВСЕГДА добавляем кнопку связи с тьютором
                        keyboard: Keyboard.builder()
                            .textButton({
                                label: '✉️ Передать вопрос тьютору',
                                payload: { command: 'confirm_send', question: row.question }, // Передаем текст вопроса
                                color: Keyboard.POSITIVE_COLOR
                            })
                            .row()
                            .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                } else {
                    await context.send('Ошибка: ответ не найден.');
                }
                return;
            }

            // --- ТЬЮТОР: ВЗЯТЬ ТИКЕТ ---
            if (messagePayload.command === 'take_ticket') {
                const ticketId = messagePayload.ticket_id;
                const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);

                if (ticketRes.rows.length === 0) return context.send('Тикет не найден (возможно, удален).');
                if (ticketRes.rows[0].status !== 'open') return context.send('Этот тикет уже кто-то взял.');

                const ticket = ticketRes.rows[0];
                await db.query("UPDATE tickets SET operator_vk_id = $1, status = 'active' WHERE id = $2", [senderId, ticketId]);
                await db.query("UPDATE users SET current_chat_ticket_id = $1, state = 'chat_mode' WHERE vk_id = $2", [ticketId, senderId]);

                await vk.api.messages.send({
                    peer_id: ticket.student_vk_id,
                    message: `👨‍💻 Тьютор взял ваш вопрос #${ticketId}! Чат открыт.`,
                    random_id: 0,
                    keyboard: Keyboard.builder()
                        .textButton({ label: `Перейти к #${ticketId}`, payload: { command: 'open_chat', ticket_id: ticketId }, color: Keyboard.POSITIVE_COLOR })
                        .inline()
                });

                await context.send({
                    message: `Вы взяли тикет #${ticketId}.\nВопрос: "${ticket.question}"`,
                    keyboard: Keyboard.builder()
                        .textButton({ label: '🏁 Завершить этот тикет', color: Keyboard.NEGATIVE_COLOR })
                        .row()
                        .textButton({ label: '⬅️ Назад к списку', color: Keyboard.SECONDARY_COLOR })
                });
                return;
            }

            // --- ОБЩЕЕ: ПЕРЕХОД В ЧАТ ---
            if (messagePayload.command === 'open_chat') {
                const ticketId = messagePayload.ticket_id;
                await db.query("UPDATE users SET current_chat_ticket_id = $1, state = 'chat_mode' WHERE vk_id = $2", [ticketId, senderId]);

                // ВЫГРУЗКА ИСТОРИИ
                const unreadMsgs = await db.query(
                    `SELECT * FROM messages WHERE ticket_id = $1 AND sender_vk_id != $2 AND is_read = FALSE ORDER BY created_at ASC`,
                    [ticketId, senderId]
                );

                if (unreadMsgs.rows.length > 0) {
                    await context.send(`📥 Пропущенные сообщения (${unreadMsgs.rows.length}):`);
                    for (let msg of unreadMsgs.rows) {
                        await context.send({
                            message: msg.text || '',
                            attachment: msg.attachments ? msg.attachments.join(',') : ''
                        });
                    }
                    await db.query(`UPDATE messages SET is_read = TRUE WHERE ticket_id = $1 AND sender_vk_id != $2`, [ticketId, senderId]);
                }

                const userRes = await db.query('SELECT role FROM users WHERE vk_id = $1', [senderId]);
                const role = userRes.rows[0].role;

                const kb = role === 'operator'
                    ? Keyboard.builder().textButton({ label: '🏁 Завершить этот тикет', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '⬅️ Назад к списку', color: Keyboard.SECONDARY_COLOR })
                    : Keyboard.builder().textButton({ label: '🏁 Завершить вопрос', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '⬅️ В меню', color: Keyboard.SECONDARY_COLOR });

                await context.send({ message: `🟢 Вы подключены к чату #${ticketId}.`, keyboard: kb });
                return;
            }

            // --- СТУДЕНТ: УПРАВЛЕНИЕ ---
            if (messagePayload.command === 'manage_ticket') {
                const ticketId = messagePayload.ticket_id;
                await db.query("UPDATE users SET state = 'ticket_manage_menu', current_chat_ticket_id = $1 WHERE vk_id = $2", [ticketId, senderId]);
                await context.send({
                    message: `📝 Управление заявкой #${ticketId}`,
                    keyboard: Keyboard.builder().textButton({ label: '✏️ Изменить текст', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '❌ Удалить заявку', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                });
                return;
            }

            // --- СТУДЕНТ: ПОДТВЕРДИТЬ ОТПРАВКУ ---
            if (messagePayload.command === 'confirm_send') {
                const questionText = messagePayload.question;

                await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                const userRes = await db.query('SELECT * FROM users WHERE vk_id = $1', [senderId]);
                const user = userRes.rows[0];

                const newTicket = await db.query(
                    "INSERT INTO tickets (student_vk_id, question) VALUES ($1, $2) RETURNING id",
                    [senderId, questionText]
                );
                const ticketId = newTicket.rows[0].id;

                await context.send({
                    message: '✅ Вопрос отправлен! Вы можете следить за статусом в "Мои обращения".',
                    keyboard: Keyboard.builder()
                        .textButton({ label: '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR })
                        .row()
                        .textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
                        .oneTime()
                });

                // Уведомление тьюторам
                const ops = await db.query(`
                    SELECT u.vk_id FROM users u
                    JOIN operator_codes oc ON u.linked_code = oc.code
                    WHERE u.role = 'operator' AND $1 = ANY(oc.allowed_groups)
                `, [user.group_number]);

                for (let op of ops.rows) {
                    try {
                        await vk.api.messages.send({
                            peer_id: op.vk_id,
                            message: `🆘 Новый вопрос #${ticketId} от ${user.full_name} (${user.group_number}):\n"${questionText}"`,
                            random_id: 0,
                            keyboard: Keyboard.builder()
                                .textButton({ label: `Взять #${ticketId}`, payload: { command: 'take_ticket', ticket_id: ticketId }, color: Keyboard.POSITIVE_COLOR })
                                .inline()
                        });
                    } catch (e) { }
                }
                return;
            }
        }

        // =========================================================
        // 2. ПОЛУЧЕНИЕ ПОЛЬЗОВАТЕЛЯ
        // =========================================================
        let userRes = await db.query('SELECT * FROM users WHERE vk_id = $1', [senderId]);
        let user = userRes.rows[0];

        if (!user) {
            await db.query('INSERT INTO users (vk_id, state) VALUES ($1, $2)', [senderId, 'registration_start']);
            await context.send({
                message: 'Добро пожаловать! Кто вы?',
                keyboard: Keyboard.builder()
                    .textButton({ label: 'Я Студент', payload: { command: 'student' }, color: Keyboard.PRIMARY_COLOR })
                    .textButton({ label: 'Я Тьютор', payload: { command: 'operator' }, color: Keyboard.POSITIVE_COLOR })
                    .oneTime()
            });
            return;
        }

        // =========================================================
        // 3. МАШИНА СОСТОЯНИЙ
        // =========================================================
        switch (user.state) {

            // --- РЕЖИМ ЧАТА ---
            case 'chat_mode':
                if (!user.current_chat_ticket_id) {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    return context.send('Ошибка сессии. В меню.');
                }
                if (text === '⬅️ Назад к списку' || text === '⬅️ В меню') {
                    await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]);
                    return mainMenu(context, user);
                }
                if (text === '🏁 Завершить этот тикет' || text === '🏁 Завершить вопрос') {
                    await db.query("UPDATE tickets SET status = 'closed' WHERE id = $1", [user.current_chat_ticket_id]);
                    const tRes = await db.query('SELECT * FROM tickets WHERE id = $1', [user.current_chat_ticket_id]);
                    const ticket = tRes.rows[0];
                    const targetId = (user.role === 'operator') ? ticket.student_vk_id : ticket.operator_vk_id;
                    if (targetId) {
                        await vk.api.messages.send({ peer_id: targetId, message: `🏁 Тикет #${ticket.id} завершен собеседником.`, random_id: 0 });
                        await db.query("UPDATE users SET current_chat_ticket_id = NULL, state = 'main_menu' WHERE vk_id = $1 AND current_chat_ticket_id = $2", [targetId, ticket.id]);
                    }
                    await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]);
                    await context.send('Тикет закрыт.');
                    return mainMenu(context, user);
                }

                const activeTicketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [user.current_chat_ticket_id]);
                if (activeTicketRes.rows.length === 0 || activeTicketRes.rows[0].status === 'closed') {
                    await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]);
                    return context.send('Этот тикет уже закрыт.');
                }
                const activeTicket = activeTicketRes.rows[0];
                const receiverId = (user.role === 'operator') ? activeTicket.student_vk_id : activeTicket.operator_vk_id;

                if (receiverId) {
                    const atts = resolveAttachments(attachments);
                    await db.query(
                        `INSERT INTO messages (ticket_id, sender_vk_id, text, attachments, is_read) VALUES ($1, $2, $3, $4, FALSE)`,
                        [user.current_chat_ticket_id, senderId, text || '', atts]
                    );

                    const receiverUserRes = await db.query('SELECT current_chat_ticket_id FROM users WHERE vk_id = $1', [receiverId]);
                    const receiverUser = receiverUserRes.rows[0];
                    const isFocus = (receiverUser && receiverUser.current_chat_ticket_id === activeTicket.id);

                    if (isFocus) {
                        try {
                            await vk.api.messages.send({ peer_id: receiverId, message: text || '', attachment: atts.join(','), random_id: 0 });
                            await db.query(`UPDATE messages SET is_read = TRUE WHERE ticket_id = $1 AND sender_vk_id = $2`, [activeTicket.id, senderId]);
                        } catch (e) { console.error(e); }
                    } else {
                        const unreadCountRes = await db.query(`SELECT COUNT(*) FROM messages WHERE ticket_id = $1 AND sender_vk_id = $2 AND is_read = FALSE`, [activeTicket.id, senderId]);
                        const unreadCount = parseInt(unreadCountRes.rows[0].count);
                        if (unreadCount === 1) {
                            const senderInfo = (user.role === 'student') ? `👤 ${user.full_name}` : '👨‍💻 Тьютор';
                            try {
                                await vk.api.messages.send({
                                    peer_id: receiverId,
                                    message: `🔔 Новое сообщение от ${senderInfo} (Тикет #${activeTicket.id})`,
                                    random_id: 0,
                                    keyboard: Keyboard.builder().textButton({ label: `Подключиться к #${activeTicket.id}`, payload: { command: 'open_chat', ticket_id: activeTicket.id }, color: Keyboard.POSITIVE_COLOR }).inline()
                                });
                            } catch (e) { }
                        }
                    }
                }
                break;

            // --- ЗАДАТЬ ВОПРОС ---
            case 'ask_question_mode':
                if (text === '🏠 В меню' || text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    return mainMenu(context, user);
                }
                if (['✉️ Задать вопрос', '👤 Профиль', '🗂 Мои обращения'].includes(text)) {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    return mainMenu(context, user);
                }

                // 1. ПОИСК ПО СЛОВАМ (ТОЧНЫЙ)
                // Используем websearch_to_tsquery — он умный, как Google.
                // Игнорирует стоп-слова ("как", "что", "где") и ищет корни.
                const keywordQuery = `
                    SELECT id, question, answer, ts_rank_cd(search_vector, websearch_to_tsquery('russian', $1)) as rank
                    FROM faq
                    WHERE search_vector @@ websearch_to_tsquery('russian', $1)
                    ORDER BY rank DESC LIMIT 3;
                `;

                const keywordRes = await db.query(keywordQuery, [text]);

                // Если нашли по словам (ХОТЯ БЫ ОДИН РЕЗУЛЬТАТ)
                // Убрали проверку rank > 0.1, так как на коротких вопросах ранг может быть маленьким
                if (keywordRes.rows.length > 0) {
                    log(`✅ Найдено по словам: "${keywordRes.rows[0].question}" (Rank: ${keywordRes.rows[0].rank})`);

                    // Если результат один - показываем сразу
                    if (keywordRes.rows.length === 1) {
                        const row = keywordRes.rows[0];
                        await context.send({
                            message: `📚 ${row.question}\n\n${row.answer}`,
                            keyboard: Keyboard.builder()
                                .textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text.substring(0, 150) }, color: Keyboard.POSITIVE_COLOR })
                                .row()
                                .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR })
                                .oneTime()
                        });
                        return;
                    } else {
                        // Если несколько вариантов - уточняем
                        let kb = Keyboard.builder();
                        let msg = '🔎 Найдено по словам:\n';

                        keywordRes.rows.forEach((row, index) => {
                            kb.textButton({
                                label: `${index + 1}. ${row.question.substring(0, 30)}...`,
                                payload: { command: 'show_faq_answer', faq_id: row.id },
                                color: Keyboard.PRIMARY_COLOR
                            }).row();
                        });

                        kb.textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text.substring(0, 150) }, color: Keyboard.POSITIVE_COLOR });
                        kb.row().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR });

                        await context.send({ message: msg, keyboard: kb.oneTime() });
                        return;
                    }
                }

                // 2. СЕМАНТИЧЕСКИЙ ПОИСК (ЕСЛИ СЛОВА НЕ СРАБОТАЛИ)
                else {
                    await context.send('🔍 Ищу по смыслу...');
                    const userVector = await getEmbedding(text);

                    if (userVector) {
                        // Ищем ближайших соседей
                        const semanticQuery = `
                            SELECT id, question, answer, (embedding <=> $1) as distance
                            FROM faq
                            ORDER BY distance ASC
                            LIMIT 3;
                        `;
                        const semanticRes = await db.query(semanticQuery, [JSON.stringify(userVector)]);

                        // Порог 0.45. Если меньше - считаем, что нашли.
                        if (semanticRes.rows.length > 0 && semanticRes.rows[0].distance < 0.45) {
                            const bestMatch = semanticRes.rows[0];
                            log(`🤖 Векторный результат: "${bestMatch.question}" (Dist: ${bestMatch.distance})`);

                            // Если очень точное совпадение (например < 0.25) - кидаем сразу
                            if (bestMatch.distance < 0.25) {
                                await context.send({
                                    message: `💡 ${bestMatch.question}\n\n${bestMatch.answer}`,
                                    keyboard: Keyboard.builder()
                                        .textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text.substring(0, 150) }, color: Keyboard.POSITIVE_COLOR })
                                        .row()
                                        .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR })
                                        .oneTime()
                                });
                                return;
                            }

                            // Если сомневаемся (0.25 - 0.45) - предлагаем варианты
                            let kb = Keyboard.builder();
                            let msg = '💡 Возможно, вы имели в виду:\n';

                            semanticRes.rows.forEach((row, index) => {
                                // Показываем только адекватные варианты
                                if (row.distance < 0.5) {
                                    kb.textButton({
                                        label: `${index + 1}. ${row.question.substring(0, 30)}...`,
                                        payload: { command: 'show_faq_answer', faq_id: row.id },
                                        color: Keyboard.PRIMARY_COLOR
                                    }).row();
                                }
                            });

                            kb.textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text.substring(0, 150) }, color: Keyboard.POSITIVE_COLOR });
                            kb.row().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR });

                            await context.send({ message: msg, keyboard: kb.oneTime() });
                            return;
                        }
                    }

                    // 3. НИЧЕГО НЕ НАШЛИ
                    await context.send({
                        message: 'Ответ не найден в базе. Отправить вопрос тьютору?',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text.substring(0, 150) }, color: Keyboard.POSITIVE_COLOR })
                            .row()
                            .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                }
                break;

            // --- ГЛАВНОЕ МЕНЮ ---
            case 'main_menu':
                if (user.role === 'operator') {
                    if (text === '📥 Очередь вопросов') {
                        const opCodeRes = await db.query('SELECT allowed_groups FROM operator_codes WHERE code = $1', [user.linked_code]);
                        const allowedGroups = opCodeRes.rows[0].allowed_groups;
                        const queueRes = await db.query(`SELECT t.id, t.question, u.full_name, u.group_number FROM tickets t JOIN users u ON t.student_vk_id = u.vk_id WHERE t.status = 'open' AND u.group_number = ANY($1) ORDER BY t.created_at ASC LIMIT 5`, [allowedGroups]);

                        if (queueRes.rows.length === 0) { await context.send('Очередь пуста 🎉'); await mainMenu(context, user); }
                        else {
                            let msg = '📥 Очередь вопросов:\n';
                            let kb = Keyboard.builder();
                            queueRes.rows.forEach(t => {
                                msg += `\n🆔 #${t.id} [${t.full_name} ${t.group_number}]: ${t.question.substring(0, 50)}...`;
                                kb.textButton({ label: `Взять #${t.id}`, payload: { command: 'take_ticket', ticket_id: t.id }, color: Keyboard.POSITIVE_COLOR }).row();
                            });
                            await context.send({ message: msg, keyboard: kb.inline() });
                            await mainMenu(context, user);
                        }
                    } else if (text === '💬 Мои диалоги') {
                        const myChatsRes = await db.query(`SELECT t.id, t.question, u.full_name, u.group_number FROM tickets t JOIN users u ON t.student_vk_id = u.vk_id WHERE t.status = 'active' AND t.operator_vk_id = $1`, [senderId]);
                        if (myChatsRes.rows.length === 0) { await context.send('У вас нет активных диалогов.'); await mainMenu(context, user); }
                        else {
                            let msg = '💬 Ваши активные диалоги:\n';
                            let kb = Keyboard.builder();
                            myChatsRes.rows.forEach(t => {
                                msg += `\n🆔 #${t.id} [${t.full_name}]: ${t.question.substring(0, 30)}...`;
                                kb.textButton({ label: `Перейти к #${t.id}`, payload: { command: 'open_chat', ticket_id: t.id }, color: Keyboard.PRIMARY_COLOR }).row();
                            });
                            await context.send({ message: msg, keyboard: kb.inline() });
                            await mainMenu(context, user);
                        }
                    } else if (text === '👤 Профиль') {
                        await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);
                        const opRes = await db.query('SELECT allowed_groups FROM operator_codes WHERE code = $1', [user.linked_code]);
                        const groups = opRes.rows.length > 0 ? opRes.rows[0].allowed_groups.join(', ') : '';
                        await context.send({
                            message: `👤 Тьютор: ${user.full_name}\nГруппы: ${groups}`,
                            keyboard: Keyboard.builder()
                                .textButton({ label: '✏️ Редактировать', color: Keyboard.PRIMARY_COLOR })
                                .row()
                                .textButton({ label: '🚪 Выйти из аккаунта', payload: { command: 'logout' }, color: Keyboard.NEGATIVE_COLOR }) // КНОПКА ВЫХОДА
                                .row()
                                .textButton({ label: '🏠 Главное меню', color: Keyboard.SECONDARY_COLOR })
                        });
                    } else { await mainMenu(context, user); }
                }
                else if (user.role === 'student') {
                    if (text === '✉️ Задать вопрос') {
                        await db.query("UPDATE users SET state = 'ask_question_mode' WHERE vk_id = $1", [senderId]);
                        await context.send({ message: 'Напишите ваш вопрос:', keyboard: Keyboard.builder().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                    } else if (text === '🗂 Мои обращения') {
                        const myTickets = await db.query(`SELECT id, question, status, created_at FROM tickets WHERE student_vk_id = $1 ORDER BY created_at DESC LIMIT 5`, [senderId]);
                        if (myTickets.rows.length === 0) { await context.send('У вас нет обращений.'); await mainMenu(context, user); }
                        else {
                            let msg = '🗂 Ваши последние обращения:\n';
                            let kb = Keyboard.builder();
                            myTickets.rows.forEach(t => {
                                const statusText = getStatusText(t.status);
                                msg += `\n#${t.id}: ${statusText}\n❓ ${t.question.substring(0, 40)}...`;
                                if (t.status === 'active') {
                                    kb.textButton({ label: `Перейти к #${t.id}`, payload: { command: 'open_chat', ticket_id: t.id }, color: Keyboard.POSITIVE_COLOR }).row();
                                } else if (t.status === 'open') {
                                    kb.textButton({ label: `✏️ Упр. #${t.id}`, payload: { command: 'manage_ticket', ticket_id: t.id }, color: Keyboard.SECONDARY_COLOR }).row();
                                }
                            });
                            await context.send({ message: msg, keyboard: kb.inline() });
                            await mainMenu(context, user);
                        }
                    } else if (text === '👤 Профиль') {
                        await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);
                        const tutorRes = await db.query('SELECT * FROM operator_codes WHERE $1 = ANY(allowed_groups)', [user.group_number]);
                        let tutorName = tutorRes.rows.length > 0 ? tutorRes.rows[0].tutor_name : 'Не назначен';
                        await context.send({ message: `👤 Студент: ${user.full_name}\nГруппа: ${user.group_number}\nТьютор: ${tutorName}`, keyboard: Keyboard.builder().textButton({ label: '✏️ Редактировать', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '❌ Удалить профиль', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🏠 Главное меню', color: Keyboard.SECONDARY_COLOR }) });
                    } else { await mainMenu(context, user); }
                }
                break;

            // --- РЕГИСТРАЦИЯ И РЕДАКТИРОВАНИЕ (БЕЗ ИЗМЕНЕНИЙ) ---
            case 'registration_start':
                if (text === 'Я Студент') { await db.query("UPDATE users SET state = 'reg_student_fio' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Введите ваше ФИО (Фамилия Имя, отчество если есть):', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                else if (text === 'Я Тьютор' || text === 'Я Оператор') { await db.query("UPDATE users SET state = 'reg_operator_code' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Введите секретный код доступа:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                break;
            case 'reg_student_fio':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'registration_start' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Кто вы?', keyboard: Keyboard.builder().textButton({ label: 'Я Студент', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Я Тьютор', color: Keyboard.POSITIVE_COLOR }).oneTime() }); }
                if (!REGEX_FIO.test(text)) return context.send('⚠️ Ошибка: Введите Фамилию и Имя кириллицей.');
                await db.query("UPDATE users SET full_name = $1, state = 'reg_student_group' WHERE vk_id = $2", [text, senderId]);
                await context.send({ message: 'Отлично! Теперь введите вашу группу (например: РИ-140944):', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                break;
            case 'reg_student_group':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'reg_student_fio' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Введите ваше ФИО:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                const group = text.toUpperCase();
                if (!REGEX_GROUP.test(group)) return context.send('⚠️ Ошибка: Формат группы должен быть "Буквы-Цифры".');
                const tutorRes = await db.query('SELECT * FROM operator_codes WHERE $1 = ANY(allowed_groups)', [group]);
                let tutorMsg = tutorRes.rows.length > 0 ? `Ваш тьютор: ${tutorRes.rows[0].tutor_name}` : '⚠️ Тьютор не назначен.';
                await db.query("UPDATE users SET group_number = $1, role = 'student', state = 'main_menu' WHERE vk_id = $2", [group, senderId]);
                await context.send({ message: `Готово! Вы студент.\n${tutorMsg}` });
                await mainMenu(context, { ...user, role: 'student' });
                break;
            case 'reg_operator_code':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'registration_start' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Кто вы?', keyboard: Keyboard.builder().textButton({ label: 'Я Студент', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Я Тьютор', color: Keyboard.POSITIVE_COLOR }).oneTime() }); }
                const codeRes = await db.query('SELECT * FROM operator_codes WHERE code = $1', [text]);
                if (codeRes.rows.length > 0) { const opData = codeRes.rows[0]; await db.query("UPDATE users SET role = 'operator', full_name = $1, linked_code = $2, state = 'main_menu' WHERE vk_id = $3", [opData.tutor_name, text, senderId]); await context.send({ message: `Успех! Вы тьютор для: ${opData.allowed_groups.join(', ')}` }); await mainMenu(context, { ...user, role: 'operator' }); }
                else { await context.send({ message: 'Неверный код.', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                break;
            case 'profile_view':
                if (user.role === 'student' && text === '✏️ Редактировать') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Что изменить?', keyboard: Keyboard.builder().textButton({ label: 'ФИО', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Группу', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                else if (user.role === 'operator' && text === '✏️ Редактировать') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Что изменить?', keyboard: Keyboard.builder().textButton({ label: 'ФИО', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Группы', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                else if (text === '❌ Удалить профиль') { await db.query("UPDATE users SET state = 'profile_delete_confirm' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Удалить профиль?', keyboard: Keyboard.builder().textButton({ label: 'Да', color: Keyboard.NEGATIVE_COLOR }).textButton({ label: 'Нет', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                else { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await mainMenu(context, user); }
                break;
            case 'profile_edit_select':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await context.send('Отмена.'); await mainMenu(context, user); return; }
                if (text === 'ФИО') { const nextState = user.role === 'operator' ? 'edit_tutor_fio' : 'edit_student_fio'; await db.query("UPDATE users SET state = $1 WHERE vk_id = $2", [nextState, senderId]); await context.send({ message: 'Новое ФИО:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                else if (text === 'Группу') { await db.query("UPDATE users SET state = 'edit_student_group' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Новая группа:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                else if (text === 'Группы') { await db.query("UPDATE users SET state = 'edit_tutor_groups' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Новые группы:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                break;
            case 'edit_student_fio':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Что изменить?', keyboard: Keyboard.builder().textButton({ label: 'ФИО', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Группу', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                if (!REGEX_FIO.test(text)) return context.send('Ошибка ФИО'); await db.query("UPDATE users SET full_name = $1, state = 'main_menu' WHERE vk_id = $2", [text, senderId]); await context.send('ФИО обновлено.'); await mainMenu(context, { ...user, full_name: text }); break;
            case 'edit_student_group':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Что изменить?', keyboard: Keyboard.builder().textButton({ label: 'ФИО', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Группу', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                const g = text.toUpperCase(); if (!REGEX_GROUP.test(g)) return context.send('Ошибка Группы'); await db.query("UPDATE users SET group_number = $1, state = 'main_menu' WHERE vk_id = $2", [g, senderId]); await context.send('Группа обновлена.'); await mainMenu(context, { ...user, group_number: g }); break;
            case 'edit_tutor_fio':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Что изменить?', keyboard: Keyboard.builder().textButton({ label: 'ФИО', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Группы', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                if (!REGEX_FIO.test(text)) return context.send('Ошибка ФИО'); await db.query("UPDATE users SET full_name = $1 WHERE vk_id = $2", [text, senderId]); await db.query("UPDATE operator_codes SET tutor_name = $1 WHERE code = $2", [text, user.linked_code]); await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await context.send('ФИО обновлено.'); await mainMenu(context, user); break;
            case 'edit_tutor_groups':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Что изменить?', keyboard: Keyboard.builder().textButton({ label: 'ФИО', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Группы', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                const ng = text.split(',').map(s => s.trim().toUpperCase()).filter(s => REGEX_GROUP.test(s)); if (ng.length === 0) return context.send('Ошибка групп'); await db.query("UPDATE operator_codes SET allowed_groups = $1 WHERE code = $2", [`{${ng.join(',')}}`, user.linked_code]); await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await context.send('Группы обновлены.'); await mainMenu(context, user); break;
            case 'profile_delete_confirm': if (text === 'Да') { await db.query('DELETE FROM users WHERE vk_id = $1', [senderId]); await context.send({ message: 'Профиль удален.', keyboard: Keyboard.builder().initial(false) }); } else { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await mainMenu(context, user); } break;
            case 'ticket_manage_menu': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); return mainMenu(context, user); } if (text === '❌ Удалить заявку') { await db.query("DELETE FROM tickets WHERE id = $1", [user.current_chat_ticket_id]); await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); await context.send('🗑 Удалено.'); return mainMenu(context, user); } if (text === '✏️ Изменить текст') { await db.query("UPDATE users SET state = 'ticket_edit_text' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Новый текст:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } break;
            case 'ticket_edit_text': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'ticket_manage_menu' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Меню заявки:', keyboard: Keyboard.builder().textButton({ label: '✏️ Изменить текст', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '❌ Удалить заявку', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }) }); } await db.query("UPDATE tickets SET question = $1 WHERE id = $2", [text, user.current_chat_ticket_id]); await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); await context.send('Текст обновлен.'); return mainMenu(context, user); break;
        }

    } catch (err) {
        console.error('CRITICAL ERROR:', err);
    }
});

async function mainMenu(context, user) {
    if (user.role === 'operator') {
        await context.send({
            message: 'Меню Тьютора:',
            keyboard: Keyboard.builder().textButton({ label: '📥 Очередь вопросов', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '💬 Мои диалоги', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
        });
    } else {
        await context.send({
            message: 'Меню Студента:',
            keyboard: Keyboard.builder().textButton({ label: '✉️ Задать вопрос', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
        });
    }
}

async function start() {
    await db.connect();
    console.log('DB Connected');
    await vk.updates.start();
    console.log('Bot started');
}

start();