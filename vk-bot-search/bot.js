// bot.js
const { VK, Keyboard } = require('vk-io');
const { db, getEmbedding } = require('./database'); // Импорт из нашего общего файла

const vk = new VK({
    token: process.env.VK_TOKEN
});

// Логи
const log = (msg) => console.log(`[Bot] ${msg}`);

const REGEX_FIO = /^[А-Яа-яЁё]+\s+[А-Яа-яЁё]+.*$/;
const REGEX_GROUP = /^[А-Я]{2,}-\d{6}$/;

const resolveAttachments = (attachments) => {
    if (!attachments) return [];
    return attachments.map(att => `${att.type}${att.ownerId}_${att.id}${att.accessKey ? '_' + att.accessKey : ''}`);
};

// ================================================================
// ОСНОВНАЯ ЛОГИКА БОТА (Скопирована из версии 6.1)
// ================================================================
vk.updates.on('message_new', async (context) => {
    if (context.isOutbox) return;
    const { text, senderId, messagePayload, attachments } = context;

    if (!text && !messagePayload && attachments.length === 0) return;

    try {
        const msgText = text || (attachments.length > 0 ? '[Вложение]' : '[Кнопка]');
        // log(`Message from ${senderId}: "${msgText}"`); // Можно раскомментировать для отладки

        // 1. ОБРАБОТКА КНОПОК
        if (messagePayload) {
            // ... ВЫХОД ...
            if (messagePayload.command === 'logout') {
                await db.query('DELETE FROM users WHERE vk_id = $1', [senderId]);
                return context.send({ message: 'Вы вышли.', keyboard: Keyboard.builder().initial(false) });
            }
            // ... ПОКАЗАТЬ ОТВЕТ FAQ ...
            if (messagePayload.command === 'show_faq_answer') {
                const faqId = messagePayload.faq_id;
                const faqRes = await db.query('SELECT question, answer FROM faq WHERE id = $1', [faqId]);
                if (faqRes.rows.length > 0) {
                    const row = faqRes.rows[0];
                    await context.send({
                        message: `📚 ${row.question}\n\n${row.answer}`,
                        keyboard: Keyboard.builder().textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: row.question }, color: Keyboard.POSITIVE_COLOR }).row().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).oneTime()
                    });
                } else { await context.send('Ошибка: ответ не найден.'); }
                return;
            }
            // ... ТЬЮТОР БЕРЕТ ТИКЕТ ...
            if (messagePayload.command === 'take_ticket') {
                const ticketId = messagePayload.ticket_id;
                const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
                if (ticketRes.rows.length === 0) return context.send('Тикет не найден.');
                if (ticketRes.rows[0].status !== 'open') return context.send('Тикет уже занят.');
                await db.query("UPDATE tickets SET operator_vk_id = $1, status = 'active' WHERE id = $2", [senderId, ticketId]);
                await db.query("UPDATE users SET current_chat_ticket_id = $1, state = 'chat_mode' WHERE vk_id = $2", [ticketId, senderId]);
                await vk.api.messages.send({ peer_id: ticketRes.rows[0].student_vk_id, message: `👨‍💻 Тьютор подключился к вопросу #${ticketId}.`, random_id: 0, keyboard: Keyboard.builder().textButton({ label: `Перейти к #${ticketId}`, payload: { command: 'open_chat', ticket_id: ticketId }, color: Keyboard.POSITIVE_COLOR }).inline() });
                await context.send({ message: `Вы взяли тикет #${ticketId}.`, keyboard: Keyboard.builder().textButton({ label: '🏁 Завершить этот тикет', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '⬅️ Назад к списку', color: Keyboard.SECONDARY_COLOR }) });
                return;
            }
            // ... ПЕРЕХОД В ЧАТ ...
            if (messagePayload.command === 'open_chat') {
                const ticketId = messagePayload.ticket_id;
                await db.query("UPDATE users SET current_chat_ticket_id = $1, state = 'chat_mode' WHERE vk_id = $2", [ticketId, senderId]);
                const userRes = await db.query('SELECT role FROM users WHERE vk_id = $1', [senderId]);
                const kb = userRes.rows[0].role === 'operator' ? Keyboard.builder().textButton({ label: '🏁 Завершить этот тикет', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '⬅️ Назад к списку', color: Keyboard.SECONDARY_COLOR }) : Keyboard.builder().textButton({ label: '🏁 Завершить вопрос', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '⬅️ В меню', color: Keyboard.SECONDARY_COLOR });
                await context.send({ message: `🟢 Чат #${ticketId} активен.`, keyboard: kb });
                // История
                const msgs = await db.query(`SELECT * FROM messages WHERE ticket_id = $1 AND sender_vk_id != $2 AND is_read = FALSE ORDER BY created_at ASC`, [ticketId, senderId]);
                if (msgs.rows.length > 0) {
                    await context.send(`📥 Новые сообщения:`);
                    for (let m of msgs.rows) await context.send({ message: m.text || '', attachment: m.attachments ? m.attachments.join(',') : '' });
                    await db.query(`UPDATE messages SET is_read = TRUE WHERE ticket_id = $1 AND sender_vk_id != $2`, [ticketId, senderId]);
                }
                return;
            }
            // ... УПРАВЛЕНИЕ ЗАЯВКОЙ ...
            if (messagePayload.command === 'manage_ticket') {
                const ticketId = messagePayload.ticket_id;
                await db.query("UPDATE users SET state = 'ticket_manage_menu', current_chat_ticket_id = $1 WHERE vk_id = $2", [ticketId, senderId]);
                await context.send({ message: `📝 Управление #${ticketId}`, keyboard: Keyboard.builder().textButton({ label: '✏️ Изменить текст', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '❌ Удалить заявку', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }) });
                return;
            }
            // ... ПОДТВЕРДИТЬ ОТПРАВКУ ...
            if (messagePayload.command === 'confirm_send') {
                const qText = messagePayload.question;
                const userRes = await db.query('SELECT group_number, full_name FROM users WHERE vk_id = $1', [senderId]);
                const user = userRes.rows[0];
                const checkTutor = await db.query('SELECT tutor_name FROM operator_codes WHERE $1 = ANY(allowed_groups)', [user.group_number]);

                if (checkTutor.rows.length === 0) {
                    await context.send({ message: `⚠️ Нет тьютора для группы ${user.group_number}.`, keyboard: Keyboard.builder().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    return;
                }

                await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                const newT = await db.query("INSERT INTO tickets (student_vk_id, question) VALUES ($1, $2) RETURNING id", [senderId, qText]);
                await context.send({ message: `✅ Отправлено (Тьютор: ${checkTutor.rows[0].tutor_name})`, keyboard: Keyboard.builder().textButton({ label: '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR }).oneTime() });

                const ops = await db.query(`SELECT u.vk_id FROM users u JOIN operator_codes oc ON u.linked_code = oc.code WHERE u.role = 'operator' AND $1 = ANY(oc.allowed_groups)`, [user.group_number]);
                for (let op of ops.rows) {
                    try { await vk.api.messages.send({ peer_id: op.vk_id, message: `🆘 Новый вопрос #${newT.rows[0].id} от ${user.full_name}:\n"${qText}"`, random_id: 0, keyboard: Keyboard.builder().textButton({ label: `Взять #${newT.rows[0].id}`, payload: { command: 'take_ticket', ticket_id: newT.rows[0].id }, color: Keyboard.POSITIVE_COLOR }).inline() }); } catch (e) { }
                }
                return;
            }
        }

        // 2. ПОЛУЧЕНИЕ ЮЗЕРА
        let userRes = await db.query('SELECT * FROM users WHERE vk_id = $1', [senderId]);
        let user = userRes.rows[0];
        if (!user) {
            await db.query('INSERT INTO users (vk_id, state) VALUES ($1, $2)', [senderId, 'registration_start']);
            await context.send({ message: 'Добро пожаловать! Кто вы?', keyboard: Keyboard.builder().textButton({ label: 'Я Студент', payload: { command: 'student' }, color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Я Тьютор', payload: { command: 'operator' }, color: Keyboard.POSITIVE_COLOR }).oneTime() });
            return;
        }

        // 3. МАШИНА СОСТОЯНИЙ
        switch (user.state) {
            // ЧАТ
            case 'chat_mode':
                if (!user.current_chat_ticket_id) { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); return context.send('Ошибка. В меню.'); }
                if (text === '⬅️ Назад к списку' || text === '⬅️ В меню') { await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); return mainMenu(context, user); }
                if (text === '🏁 Завершить этот тикет' || text === '🏁 Завершить вопрос') {
                    await db.query("UPDATE tickets SET status = 'closed' WHERE id = $1", [user.current_chat_ticket_id]);
                    const t = (await db.query('SELECT * FROM tickets WHERE id = $1', [user.current_chat_ticket_id])).rows[0];
                    const targetId = (user.role === 'operator') ? t.student_vk_id : t.operator_vk_id;
                    if (targetId) {
                        await vk.api.messages.send({ peer_id: targetId, message: `🏁 Тикет #${t.id} завершен.`, random_id: 0 });
                        await db.query("UPDATE users SET current_chat_ticket_id = NULL, state = 'main_menu' WHERE vk_id = $1 AND current_chat_ticket_id = $2", [targetId, t.id]);
                    }
                    await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]);
                    await context.send('Тикет закрыт.');
                    return mainMenu(context, user);
                }
                // Пересылка
                const activeT = (await db.query('SELECT * FROM tickets WHERE id = $1', [user.current_chat_ticket_id])).rows[0];
                if (!activeT || activeT.status === 'closed') { await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); return context.send('Тикет закрыт.'); }
                const recId = (user.role === 'operator') ? activeT.student_vk_id : activeT.operator_vk_id;
                if (recId) {
                    const atts = resolveAttachments(attachments);
                    await db.query(`INSERT INTO messages (ticket_id, sender_vk_id, text, attachments, is_read) VALUES ($1, $2, $3, $4, FALSE)`, [user.current_chat_ticket_id, senderId, text || '', atts]);
                    const recUser = (await db.query('SELECT current_chat_ticket_id FROM users WHERE vk_id = $1', [recId])).rows[0];
                    if (recUser && recUser.current_chat_ticket_id === activeT.id) {
                        try { await vk.api.messages.send({ peer_id: recId, message: text || '', attachment: atts.join(','), random_id: 0 }); await db.query(`UPDATE messages SET is_read = TRUE WHERE ticket_id = $1 AND sender_vk_id = $2`, [activeT.id, senderId]); } catch (e) { }
                    } else {
                        const unread = parseInt((await db.query(`SELECT COUNT(*) FROM messages WHERE ticket_id = $1 AND sender_vk_id = $2 AND is_read = FALSE`, [activeT.id, senderId])).rows[0].count);
                        if (unread === 1) {
                            const info = (user.role === 'student') ? `👤 ${user.full_name}` : '👨‍💻 Тьютор';
                            try { await vk.api.messages.send({ peer_id: recId, message: `🔔 Новое от ${info} (#${activeT.id})`, random_id: 0, keyboard: Keyboard.builder().textButton({ label: `Подключиться к #${activeT.id}`, payload: { command: 'open_chat', ticket_id: activeT.id }, color: Keyboard.POSITIVE_COLOR }).inline() }); } catch (e) { }
                        }
                    }
                }
                break;

            // ПОИСК
            case 'ask_question_mode':
                if (text === '🏠 В меню' || text === '🔙 Назад' || ['✉️ Задать вопрос', '👤 Профиль', '🗂 Мои обращения'].includes(text)) { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); return mainMenu(context, user); }

                // Слова
                const kwRes = await db.query(`SELECT id, question, answer FROM faq WHERE search_vector @@ websearch_to_tsquery('russian', $1) LIMIT 3`, [text]);
                if (kwRes.rows.length > 0) {
                    if (kwRes.rows.length === 1) {
                        await context.send({ message: `📚 ${kwRes.rows[0].question}\n\n${kwRes.rows[0].answer}`, keyboard: Keyboard.builder().textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text }, color: Keyboard.POSITIVE_COLOR }).row().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                        return;
                    } else {
                        let kb = Keyboard.builder();
                        kwRes.rows.forEach((r, i) => kb.textButton({ label: `${i + 1}. ${r.question.substring(0, 30)}...`, payload: { command: 'show_faq_answer', faq_id: r.id }, color: Keyboard.PRIMARY_COLOR }).row());
                        kb.textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text }, color: Keyboard.POSITIVE_COLOR }).row().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR });
                        await context.send({ message: '🔎 Нашел по словам:', keyboard: kb.oneTime() });
                        return;
                    }
                }
                // Вектора
                await context.send('🔍 Ищу по смыслу...');
                const vec = await getEmbedding(text);
                if (vec) {
                    const semRes = await db.query(`SELECT id, question, answer, (embedding <=> $1) as distance FROM faq ORDER BY distance ASC LIMIT 3`, [JSON.stringify(vec)]);
                    if (semRes.rows.length > 0 && semRes.rows[0].distance < 0.45) {
                        if (semRes.rows[0].distance < 0.2) {
                            await context.send({ message: `💡 ${semRes.rows[0].question}\n\n${semRes.rows[0].answer}`, keyboard: Keyboard.builder().textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text }, color: Keyboard.POSITIVE_COLOR }).row().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                            return;
                        }
                        let kb = Keyboard.builder();
                        let found = false;
                        semRes.rows.forEach((r, i) => { if (r.distance < 0.5) { found = true; kb.textButton({ label: `${i + 1}. ${r.question.substring(0, 30)}...`, payload: { command: 'show_faq_answer', faq_id: r.id }, color: Keyboard.PRIMARY_COLOR }).row(); } });
                        if (found) {
                            kb.textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text }, color: Keyboard.POSITIVE_COLOR }).row().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR });
                            await context.send({ message: '💡 Возможно, вы имели в виду:', keyboard: kb.oneTime() });
                            return;
                        }
                    }
                }
                await context.send({ message: 'Не нашел. Передать тьютору?', keyboard: Keyboard.builder().textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text }, color: Keyboard.POSITIVE_COLOR }).row().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                break;

            // МЕНЮ
            case 'main_menu':
                if (user.role === 'operator') {
                    if (text === '📥 Очередь вопросов') {
                        const gr = (await db.query('SELECT allowed_groups FROM operator_codes WHERE code = $1', [user.linked_code])).rows[0].allowed_groups;
                        const q = await db.query(`SELECT t.id, t.question, u.full_name, u.group_number FROM tickets t JOIN users u ON t.student_vk_id = u.vk_id WHERE t.status = 'open' AND u.group_number = ANY($1) ORDER BY t.created_at ASC LIMIT 5`, [gr]);
                        if (q.rows.length === 0) { await context.send('Очередь пуста 🎉'); await mainMenu(context, user); }
                        else {
                            let msg = '📥 Очередь:\n'; let kb = Keyboard.builder();
                            q.rows.forEach(t => { msg += `\n🆔 #${t.id} [${t.full_name} ${t.group_number}]: ${t.question.substring(0, 50)}...`; kb.textButton({ label: `Взять #${t.id}`, payload: { command: 'take_ticket', ticket_id: t.id }, color: Keyboard.POSITIVE_COLOR }).row(); });
                            await context.send({ message: msg, keyboard: kb.inline() }); await mainMenu(context, user);
                        }
                    } else if (text === '💬 Мои диалоги') {
                        const q = await db.query(`SELECT t.id, t.question, u.full_name FROM tickets t JOIN users u ON t.student_vk_id = u.vk_id WHERE t.status = 'active' AND t.operator_vk_id = $1`, [senderId]);
                        if (q.rows.length === 0) { await context.send('Нет активных диалогов.'); await mainMenu(context, user); }
                        else {
                            let msg = '💬 Диалоги:\n'; let kb = Keyboard.builder();
                            q.rows.forEach(t => { msg += `\n🆔 #${t.id} [${t.full_name}]: ${t.question.substring(0, 30)}...`; kb.textButton({ label: `Перейти к #${t.id}`, payload: { command: 'open_chat', ticket_id: t.id }, color: Keyboard.PRIMARY_COLOR }).row(); });
                            await context.send({ message: msg, keyboard: kb.inline() }); await mainMenu(context, user);
                        }
                    } else if (text === '👤 Профиль') {
                        await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);
                        const gr = (await db.query('SELECT allowed_groups FROM operator_codes WHERE code = $1', [user.linked_code])).rows[0].allowed_groups;
                        await context.send({ message: `👤 Тьютор: ${user.full_name}\nГруппы: ${gr}`, keyboard: Keyboard.builder().textButton({ label: '✏️ Редактировать', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🚪 Выйти из аккаунта', payload: { command: 'logout' }, color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🏠 Главное меню', color: Keyboard.SECONDARY_COLOR }) });
                    } else { await mainMenu(context, user); }
                } else {
                    if (text === '✉️ Задать вопрос') { await db.query("UPDATE users SET state = 'ask_question_mode' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Напишите вопрос:', keyboard: Keyboard.builder().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).oneTime() }); }
                    else if (text === '🗂 Мои обращения') {
                        const q = await db.query(`SELECT id, question, status FROM tickets WHERE student_vk_id = $1 ORDER BY created_at DESC LIMIT 5`, [senderId]);
                        if (q.rows.length === 0) { await context.send('Нет обращений.'); await mainMenu(context, user); }
                        else {
                            let msg = '🗂 Ваши обращения:\n'; let kb = Keyboard.builder();
                            q.rows.forEach(t => {
                                const st = (t.status === 'open' ? '⏳' : (t.status === 'active' ? '🟢' : '🏁'));
                                msg += `\n#${t.id}: ${st}\n❓ ${t.question.substring(0, 40)}...`;
                                if (t.status === 'active') kb.textButton({ label: `Перейти к #${t.id}`, payload: { command: 'open_chat', ticket_id: t.id }, color: Keyboard.POSITIVE_COLOR }).row();
                                else if (t.status === 'open') kb.textButton({ label: `✏️ Упр. #${t.id}`, payload: { command: 'manage_ticket', ticket_id: t.id }, color: Keyboard.SECONDARY_COLOR }).row();
                            });
                            await context.send({ message: msg, keyboard: kb.inline() }); await mainMenu(context, user);
                        }
                    } else if (text === '👤 Профиль') {
                        await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);
                        const tName = (await db.query('SELECT * FROM operator_codes WHERE $1 = ANY(allowed_groups)', [user.group_number])).rows[0]?.tutor_name || 'Нет';
                        await context.send({ message: `👤 Студент: ${user.full_name}\nГруппа: ${user.group_number}\nТьютор: ${tName}`, keyboard: Keyboard.builder().textButton({ label: '✏️ Редактировать', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '❌ Удалить профиль', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🏠 Главное меню', color: Keyboard.SECONDARY_COLOR }) });
                    } else { await mainMenu(context, user); }
                }
                break;

            // КЕЙСЫ РЕГИСТРАЦИИ И ПРОФИЛЯ (Я их сжал для краткости, они те же)
            // При копировании убедись, что они есть!
            case 'registration_start': if (text === 'Я Студент') { await db.query("UPDATE users SET state = 'reg_student_fio' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Введите ФИО:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } else if (text === 'Я Тьютор') { await db.query("UPDATE users SET state = 'reg_operator_code' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Введите код:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } break;
            case 'reg_student_fio': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'registration_start' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Кто вы?', keyboard: Keyboard.builder().textButton({ label: 'Я Студент', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Я Тьютор', color: Keyboard.POSITIVE_COLOR }).oneTime() }); } if (!REGEX_FIO.test(text)) return context.send('Ошибка ФИО'); await db.query("UPDATE users SET full_name = $1, state = 'reg_student_group' WHERE vk_id = $2", [text, senderId]); await context.send({ message: 'Группа:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); break;
            case 'reg_student_group': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'reg_student_fio' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Введите ФИО:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } const g = text.toUpperCase(); if (!REGEX_GROUP.test(g)) return context.send('Ошибка группы'); const tn = (await db.query('SELECT * FROM operator_codes WHERE $1 = ANY(allowed_groups)', [g])).rows[0]?.tutor_name || 'Нет'; await db.query("UPDATE users SET group_number = $1, role = 'student', state = 'main_menu' WHERE vk_id = $2", [g, senderId]); await context.send(`Готово. Тьютор: ${tn}`); await mainMenu(context, { ...user, role: 'student' }); break;
            case 'reg_operator_code': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'registration_start' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Кто вы?', keyboard: Keyboard.builder().textButton({ label: 'Я Студент', color: Keyboard.PRIMARY_COLOR }).textButton({ label: 'Я Тьютор', color: Keyboard.POSITIVE_COLOR }).oneTime() }); } const cRes = await db.query('SELECT * FROM operator_codes WHERE code = $1', [text]); if (cRes.rows.length > 0) { await db.query("UPDATE users SET role = 'operator', full_name = $1, linked_code = $2, state = 'main_menu' WHERE vk_id = $3", [cRes.rows[0].tutor_name, text, senderId]); await context.send('Успех!'); await mainMenu(context, { ...user, role: 'operator' }); } else { await context.send({ message: 'Неверный код', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } break;
            case 'profile_view': if (text === '✏️ Редактировать') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Что изменить?', keyboard: Keyboard.builder().textButton({ label: 'ФИО', color: Keyboard.PRIMARY_COLOR }).textButton({ label: user.role === 'student' ? 'Группу' : 'Группы', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } else if (text === '❌ Удалить профиль') { await db.query("UPDATE users SET state = 'profile_delete_confirm' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Удалить?', keyboard: Keyboard.builder().textButton({ label: 'Да', color: Keyboard.NEGATIVE_COLOR }).textButton({ label: 'Нет', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } else { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await mainMenu(context, user); } break;
            case 'profile_edit_select': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await mainMenu(context, user); return; } if (text === 'ФИО') { const s = user.role === 'operator' ? 'edit_tutor_fio' : 'edit_student_fio'; await db.query("UPDATE users SET state = $1 WHERE vk_id = $2", [s, senderId]); await context.send({ message: 'Новое ФИО:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } else if (text.includes('Групп')) { const s = user.role === 'operator' ? 'edit_tutor_groups' : 'edit_student_group'; await db.query("UPDATE users SET state = $1 WHERE vk_id = $2", [s, senderId]); await context.send({ message: 'Новая группа:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } break;
            case 'edit_student_fio': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send('Что изменить?'); } if (!REGEX_FIO.test(text)) return context.send('Ошибка ФИО'); await db.query("UPDATE users SET full_name = $1, state = 'main_menu' WHERE vk_id = $2", [text, senderId]); await context.send('Обновлено.'); await mainMenu(context, user); break;
            case 'edit_student_group': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send('Что изменить?'); } const g2 = text.toUpperCase(); if (!REGEX_GROUP.test(g2)) return context.send('Ошибка'); await db.query("UPDATE users SET group_number = $1, state = 'main_menu' WHERE vk_id = $2", [g2, senderId]); await context.send('Обновлено.'); await mainMenu(context, user); break;
            case 'edit_tutor_fio': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send('Что изменить?'); } if (!REGEX_FIO.test(text)) return context.send('Ошибка ФИО'); await db.query("UPDATE users SET full_name = $1 WHERE vk_id = $2", [text, senderId]); await db.query("UPDATE operator_codes SET tutor_name = $1 WHERE code = $2", [text, user.linked_code]); await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await context.send('Обновлено.'); await mainMenu(context, user); break;
            case 'edit_tutor_groups': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]); return context.send('Что изменить?'); } const ng = text.split(',').map(s => s.trim().toUpperCase()).filter(s => REGEX_GROUP.test(s)); if (ng.length === 0) return context.send('Ошибка'); await db.query("UPDATE operator_codes SET allowed_groups = $1 WHERE code = $2", [`{${ng.join(',')}}`, user.linked_code]); await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await context.send('Обновлено.'); await mainMenu(context, user); break;
            case 'profile_delete_confirm': if (text === 'Да') { await db.query('DELETE FROM users WHERE vk_id = $1', [senderId]); await context.send({ message: 'Удален.', keyboard: Keyboard.builder().initial(false) }); } else { await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]); await mainMenu(context, user); } break;
            case 'ticket_manage_menu': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); return mainMenu(context, user); } if (text === '❌ Удалить заявку') { await db.query("DELETE FROM tickets WHERE id = $1", [user.current_chat_ticket_id]); await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); await context.send('Удалено.'); return mainMenu(context, user); } if (text === '✏️ Изменить текст') { await db.query("UPDATE users SET state = 'ticket_edit_text' WHERE vk_id = $1", [senderId]); await context.send({ message: 'Новый текст:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() }); } break;
            case 'ticket_edit_text': if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'ticket_manage_menu' WHERE vk_id = $1", [senderId]); return context.send({ message: 'Меню:', keyboard: Keyboard.builder().textButton({ label: '✏️', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '❌', color: Keyboard.NEGATIVE_COLOR }).row().textButton({ label: '🔙', color: Keyboard.SECONDARY_COLOR }) }); } await db.query("UPDATE tickets SET question = $1 WHERE id = $2", [text, user.current_chat_ticket_id]); await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]); await context.send('Обновлено.'); return mainMenu(context, user); break;
        }

    } catch (err) { console.error(err); }
});

async function mainMenu(context, user) {
    if (user.role === 'operator') {
        await context.send({
            message: 'Меню тьютора:',
            keyboard: Keyboard.builder().textButton({ label: '📥 Очередь вопросов', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '💬 Мои диалоги', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
        });
    } else {
        await context.send({
            message: 'Меню студента:',
            keyboard: Keyboard.builder().textButton({ label: '✉️ Задать вопрос', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR }).row().textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
        });
    }
}

// Экспорт для использования в index.js
module.exports = async () => {
    console.log('🚀 Бот запущен (bot.js)');
    await vk.updates.start();
};