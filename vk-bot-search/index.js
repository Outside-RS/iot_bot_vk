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

const log = (emoji, msg) => console.log(`${emoji} [${new Date().toLocaleTimeString()}] ${msg}`);

// Regex
const REGEX_FIO = /^[А-Яа-яЁё]+\s+[А-Яа-яЁё]+.*$/; // Фамилия Имя
const REGEX_GROUP = /^[А-Я]{2,}-\d{6}$/; // РИ-140944

vk.updates.on('message_new', async (context) => {
    if (context.isOutbox) return;
    const { text, senderId, messagePayload } = context;

    if (!text && !messagePayload) return;

    try {
        log('📩', `Сообщение от ${senderId}: "${text || '[Payload]'}"`);

        // =========================================================
        // 1. ОБРАБОТКА КНОПОК (PAYLOAD)
        // =========================================================
        if (messagePayload) {
            // --- ТЬЮТОР: ВЗЯТЬ ТИКЕТ ---
            if (messagePayload.command === 'take_ticket') {
                const ticketId = messagePayload.ticket_id;
                const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);

                if (ticketRes.rows.length === 0) return context.send('Тикет не найден.');
                if (ticketRes.rows[0].status !== 'open') return context.send('Этот тикет уже кто-то взял.');

                const ticket = ticketRes.rows[0];
                await db.query("UPDATE tickets SET operator_vk_id = $1, status = 'active' WHERE id = $2", [senderId, ticketId]);
                await db.query("UPDATE users SET current_chat_ticket_id = $1, state = 'chat_mode' WHERE vk_id = $2", [ticketId, senderId]);

                // Уведомляем студента
                await vk.api.messages.send({
                    peer_id: ticket.student_vk_id,
                    message: '👨‍💻 Тьютор взял ваш вопрос! Вы можете писать сюда.',
                    random_id: 0
                });

                await context.send({
                    message: `Вы взяли тикет #${ticketId}.\nВопрос: "${ticket.question}"\n\nТеперь вы в чате.`,
                    keyboard: Keyboard.builder()
                        .textButton({ label: '🏁 Завершить этот тикет', color: Keyboard.NEGATIVE_COLOR })
                        .row()
                        .textButton({ label: '⬅️ Назад к списку', color: Keyboard.SECONDARY_COLOR })
                });
                return;
            }

            // --- ПЕРЕХОД В ЧАТ (ОБЩЕЕ) ---
            if (messagePayload.command === 'open_chat') {
                const ticketId = messagePayload.ticket_id;
                await db.query("UPDATE users SET current_chat_ticket_id = $1, state = 'chat_mode' WHERE vk_id = $2", [ticketId, senderId]);

                const userRes = await db.query('SELECT role FROM users WHERE vk_id = $1', [senderId]);
                const role = userRes.rows[0].role;

                if (role === 'operator') {
                    await context.send({
                        message: `Переключились в чат #${ticketId}.`,
                        keyboard: Keyboard.builder()
                            .textButton({ label: '🏁 Завершить этот тикет', color: Keyboard.NEGATIVE_COLOR })
                            .row()
                            .textButton({ label: '⬅️ Назад к списку', color: Keyboard.SECONDARY_COLOR })
                    });
                } else {
                    await context.send({
                        message: `Вы в чате по заявке #${ticketId}.`,
                        keyboard: Keyboard.builder()
                            .textButton({ label: '🏁 Завершить вопрос', color: Keyboard.NEGATIVE_COLOR })
                            .row()
                            .textButton({ label: '⬅️ В меню', color: Keyboard.SECONDARY_COLOR })
                    });
                }
                return;
            }

            // --- СТУДЕНТ: ПОДТВЕРДИТЬ ОТПРАВКУ ---
            if (messagePayload.command === 'confirm_send') {
                const questionText = messagePayload.question;
                let userRes = await db.query('SELECT * FROM users WHERE vk_id = $1', [senderId]);
                let user = userRes.rows[0];

                const newTicket = await db.query(
                    "INSERT INTO tickets (student_vk_id, question) VALUES ($1, $2) RETURNING id",
                    [senderId, questionText]
                );
                const ticketId = newTicket.rows[0].id;

                await context.send({
                    message: '✅ Ваш вопрос передан тьютору. Вы получите уведомление, когда его возьмут.',
                    keyboard: Keyboard.builder()
                        .textButton({ label: '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR })
                        .row()
                        .textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
                        .oneTime()
                });

                // Уведомляем тьюторов
                const findOpsQuery = `
                    SELECT u.vk_id FROM users u
                    JOIN operator_codes oc ON u.linked_code = oc.code
                    WHERE u.role = 'operator' AND $1 = ANY(oc.allowed_groups)
                `;
                const ops = await db.query(findOpsQuery, [user.group_number]);

                for (let op of ops.rows) {
                    try {
                        await vk.api.messages.send({
                            peer_id: op.vk_id,
                            message: `🆘 Новый вопрос #${ticketId} от ${user.full_name} (${user.group_number}):\n"${questionText}"`,
                            random_id: 0,
                            keyboard: Keyboard.builder()
                                .textButton({
                                    label: `Взять #${ticketId}`,
                                    payload: { command: 'take_ticket', ticket_id: ticketId },
                                    color: Keyboard.POSITIVE_COLOR
                                })
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
                    .textButton({ label: 'Я Тьютор', payload: { command: 'operator' }, color: Keyboard.POSITIVE_COLOR }) // Исправил на "Тьютор"
                    .oneTime()
            });
            return;
        }

        // =========================================================
        // 3. МАШИНА СОСТОЯНИЙ (STATE MACHINE)
        // =========================================================
        switch (user.state) {

            // -----------------------------------------------------
            // РЕЖИМ ЧАТА
            // -----------------------------------------------------
            case 'chat_mode':
                if (!user.current_chat_ticket_id) {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    return context.send('Ошибка: нет активного чата. Возврат в меню.');
                }

                // Выход в меню
                if (text === '⬅️ Назад к списку' || text === '⬅️ В меню') {
                    await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]);
                    return context.send({
                        message: 'Вы вышли в меню.',
                        keyboard: Keyboard.builder()
                            .textButton({ label: user.role === 'operator' ? '📥 Очередь вопросов' : '✉️ Задать вопрос', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: user.role === 'operator' ? '💬 Мои диалоги' : '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
                    });
                }

                // Завершение тикета
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
                    return context.send({
                        message: 'Тикет закрыт.',
                        keyboard: Keyboard.builder()
                            .textButton({ label: user.role === 'operator' ? '📥 Очередь вопросов' : '✉️ Задать вопрос', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: user.role === 'operator' ? '💬 Мои диалоги' : '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
                    });
                }

                // Пересылка сообщений
                const activeTicketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [user.current_chat_ticket_id]);
                if (activeTicketRes.rows.length === 0 || activeTicketRes.rows[0].status === 'closed') {
                    await db.query("UPDATE users SET state = 'main_menu', current_chat_ticket_id = NULL WHERE vk_id = $1", [senderId]);
                    return context.send('Этот тикет уже закрыт.');
                }
                const activeTicket = activeTicketRes.rows[0];
                const receiverId = (user.role === 'operator') ? activeTicket.student_vk_id : activeTicket.operator_vk_id;

                if (receiverId) {
                    const receiverUserRes = await db.query('SELECT current_chat_ticket_id, role FROM users WHERE vk_id = $1', [receiverId]);
                    const receiverUser = receiverUserRes.rows[0];

                    let msgPrefix = (receiverUser.current_chat_ticket_id !== activeTicket.id) ? '🔔 (Фон) ' : '';
                    let senderInfo = (user.role === 'student') ? `👤 [${user.full_name} ${user.group_number}]` : '👨‍💻 Тьютор';

                    try {
                        await vk.api.messages.send({
                            peer_id: receiverId,
                            message: `${msgPrefix}${senderInfo}:\n${text}`, // Добавил перенос строки \n
                            random_id: 0
                        });
                    } catch (e) { }
                }
                break;

            // -----------------------------------------------------
            // РЕГИСТРАЦИЯ (Студент и Тьютор)
            // -----------------------------------------------------
            case 'registration_start':
                if (text === 'Я Студент') {
                    await db.query("UPDATE users SET state = 'reg_student_fio' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Введите ваше ФИО (Фамилия Имя, отчество если есть):',
                        keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime()
                    });
                } else if (text === 'Я Тьютор' || text === 'Я Оператор') {
                    await db.query("UPDATE users SET state = 'reg_operator_code' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Введите секретный код доступа:',
                        keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime()
                    });
                }
                break;

            case 'reg_student_fio':
                if (text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'registration_start' WHERE vk_id = $1", [senderId]);
                    return context.send({
                        message: 'Кто вы?',
                        keyboard: Keyboard.builder()
                            .textButton({ label: 'Я Студент', color: Keyboard.PRIMARY_COLOR })
                            .textButton({ label: 'Я Тьютор', color: Keyboard.POSITIVE_COLOR }).oneTime()
                    });
                }
                if (!REGEX_FIO.test(text)) return context.send('⚠️ Ошибка: Введите Фамилию и Имя кириллицей (минимум 2 слова).');
                await db.query("UPDATE users SET full_name = $1, state = 'reg_student_group' WHERE vk_id = $2", [text, senderId]);
                await context.send({
                    message: 'Отлично! Теперь введите вашу группу (например: РИ-140944):',
                    keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime()
                });
                break;

            case 'reg_student_group':
                if (text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'reg_student_fio' WHERE vk_id = $1", [senderId]);
                    return context.send({
                        message: 'Введите ваше ФИО:',
                        keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime()
                    });
                }
                const group = text.toUpperCase();
                if (!REGEX_GROUP.test(group)) return context.send('⚠️ Ошибка: Формат группы должен быть "Буквы-Цифры" (например "РИ-140944").');

                const tutorRes = await db.query('SELECT * FROM operator_codes WHERE $1 = ANY(allowed_groups)', [group]);
                let tutorMsg = tutorRes.rows.length > 0 ? `Ваш тьютор: ${tutorRes.rows[0].tutor_name}` : '⚠️ Тьютор не назначен.';

                await db.query("UPDATE users SET group_number = $1, role = 'student', state = 'main_menu' WHERE vk_id = $2", [group, senderId]);
                await context.send({
                    message: `Готово! Вы студент.\n${tutorMsg}`,
                    keyboard: Keyboard.builder()
                        .textButton({ label: '✉️ Задать вопрос', color: Keyboard.PRIMARY_COLOR })
                        .row()
                        .textButton({ label: '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR })
                        .row()
                        .textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
                });
                break;

            case 'reg_operator_code':
                if (text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'registration_start' WHERE vk_id = $1", [senderId]);
                    return context.send({
                        message: 'Кто вы?',
                        keyboard: Keyboard.builder()
                            .textButton({ label: 'Я Студент', color: Keyboard.PRIMARY_COLOR })
                            .textButton({ label: 'Я Тьютор', color: Keyboard.POSITIVE_COLOR }).oneTime()
                    });
                }
                const codeRes = await db.query('SELECT * FROM operator_codes WHERE code = $1', [text]);
                if (codeRes.rows.length > 0) {
                    const opData = codeRes.rows[0];
                    await db.query("UPDATE users SET role = 'operator', full_name = $1, linked_code = $2, state = 'main_menu' WHERE vk_id = $3", [opData.tutor_name, text, senderId]);
                    await context.send({
                        message: `Успех! Вы тьютор для: ${opData.allowed_groups.join(', ')}`,
                        keyboard: Keyboard.builder()
                            .textButton({ label: '📥 Очередь вопросов', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: '💬 Мои диалоги', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
                    });
                } else {
                    await context.send({
                        message: 'Неверный код.',
                        keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime()
                    });
                }
                break;

            // -----------------------------------------------------
            // РЕДАКТИРОВАНИЕ ПРОФИЛЯ
            // -----------------------------------------------------
            case 'profile_view':
                if (user.role === 'student' && text === '✏️ Редактировать') {
                    await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Что изменить?',
                        keyboard: Keyboard.builder()
                            .textButton({ label: 'ФИО', color: Keyboard.PRIMARY_COLOR })
                            .textButton({ label: 'Группу', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                } else if (user.role === 'operator' && text === '✏️ Редактировать') {
                    await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Что изменить?',
                        keyboard: Keyboard.builder()
                            .textButton({ label: 'ФИО', color: Keyboard.PRIMARY_COLOR })
                            .textButton({ label: 'Группы', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                } else if (text === '❌ Удалить профиль') {
                    await db.query("UPDATE users SET state = 'profile_delete_confirm' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Удалить профиль? Это нельзя отменить.',
                        keyboard: Keyboard.builder().textButton({ label: 'Да', color: Keyboard.NEGATIVE_COLOR }).textButton({ label: 'Нет', color: Keyboard.SECONDARY_COLOR }).oneTime()
                    });
                } else if (text === '🏠 Главное меню' || text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    await mainMenu(context, user); // Вызов функции меню
                }
                break;

            case 'profile_edit_select':
                if (text === 'ФИО') {
                    const nextState = user.role === 'operator' ? 'edit_tutor_fio' : 'edit_student_fio';
                    await db.query("UPDATE users SET state = $1 WHERE vk_id = $2", [nextState, senderId]);
                    await context.send({ message: 'Введите новое ФИО:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                } else if (text === 'Группу' && user.role === 'student') {
                    await db.query("UPDATE users SET state = 'edit_student_group' WHERE vk_id = $1", [senderId]);
                    await context.send({ message: 'Введите новую группу:', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                } else if (text === 'Группы' && user.role === 'operator') {
                    await db.query("UPDATE users SET state = 'edit_tutor_groups' WHERE vk_id = $1", [senderId]);
                    await context.send({ message: 'Введите группы через запятую (например: РИ-101, РИ-102):', keyboard: Keyboard.builder().textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR }).oneTime() });
                } else {
                    await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);
                    await context.send('Отмена редактирования.');
                    // Перезагрузка профиля (можно сделать рекурсивно, но проще отправить в меню)
                    await mainMenu(context, user);
                }
                break;

            // Логика сохранения изменений (Студент)
            case 'edit_student_fio':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]); return mainMenu(context, user); }
                if (!REGEX_FIO.test(text)) return context.send('⚠️ Ошибка: Введите Фамилию и Имя кириллицей.');
                await db.query("UPDATE users SET full_name = $1, state = 'main_menu' WHERE vk_id = $2", [text, senderId]);
                await context.send('✅ ФИО обновлено.');
                await mainMenu(context, { ...user, full_name: text });
                break;

            case 'edit_student_group':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]); return mainMenu(context, user); }
                const g = text.toUpperCase();
                if (!REGEX_GROUP.test(g)) return context.send('⚠️ Ошибка: Неверный формат группы.');
                await db.query("UPDATE users SET group_number = $1, state = 'main_menu' WHERE vk_id = $2", [g, senderId]);
                await context.send('✅ Группа обновлена.');
                await mainMenu(context, { ...user, group_number: g });
                break;

            // Логика сохранения изменений (Тьютор)
            case 'edit_tutor_fio':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]); return mainMenu(context, user); }
                if (!REGEX_FIO.test(text)) return context.send('⚠️ Ошибка: Введите Фамилию и Имя кириллицей.');
                await db.query("UPDATE users SET full_name = $1 WHERE vk_id = $2", [text, senderId]);
                await db.query("UPDATE operator_codes SET tutor_name = $1 WHERE code = $2", [text, user.linked_code]); // Обновляем и в кодах
                await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                await context.send('✅ ФИО тьютора обновлено.');
                await mainMenu(context, user);
                break;

            case 'edit_tutor_groups':
                if (text === '🔙 Назад') { await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]); return mainMenu(context, user); }
                // Парсим группы: разбиваем по запятой, убираем пробелы, в верхний регистр
                const newGroups = text.split(',').map(s => s.trim().toUpperCase()).filter(s => REGEX_GROUP.test(s));
                if (newGroups.length === 0) return context.send('⚠️ Ошибка: Ни одна группа не прошла проверку формата (АА-000000).');

                // Postgres требует массив в формате {a,b,c}
                const pgArray = `{${newGroups.join(',')}}`;
                await db.query("UPDATE operator_codes SET allowed_groups = $1 WHERE code = $2", [pgArray, user.linked_code]);
                await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                await context.send(`✅ Группы обновлены: ${newGroups.join(', ')}`);
                await mainMenu(context, user);
                break;

            case 'profile_delete_confirm':
                if (text === 'Да') {
                    await db.query('DELETE FROM users WHERE vk_id = $1', [senderId]);
                    await context.send({ message: 'Профиль удален.', keyboard: Keyboard.builder().initial(false) });
                } else {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    await mainMenu(context, user);
                }
                break;

            // -----------------------------------------------------
            // ЗАДАТЬ ВОПРОС (ОТДЕЛЬНЫЙ СТЕЙТ)
            // -----------------------------------------------------
            case 'ask_question_mode':
                if (text === '🏠 В меню' || text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    return mainMenu(context, user);
                }

                // Если ввели текст вопроса -> ищем в FAQ
                const faqQuery = `
                    SELECT answer, ts_rank_cd(search_vector, plainto_tsquery('russian', $1)) as rank
                    FROM faq
                    WHERE search_vector @@ plainto_tsquery('russian', $1)
                    ORDER BY rank DESC LIMIT 1;
                `;
                const faqRes = await db.query(faqQuery, [text]);

                if (faqRes.rows.length > 0) {
                    await context.send({
                        message: `📚 Нашел в базе:\n${faqRes.rows[0].answer}\n\nЕсли это не то, нажмите "Передать тьютору".`,
                        keyboard: Keyboard.builder()
                            .textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text.substring(0, 150) }, color: Keyboard.POSITIVE_COLOR })
                            .row()
                            .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                } else {
                    await context.send({
                        message: 'Ответ не найден в базе. Отправить вопрос тьютору?',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '✉️ Передать вопрос тьютору', payload: { command: 'confirm_send', question: text.substring(0, 150) }, color: Keyboard.POSITIVE_COLOR })
                            .row()
                            .textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                }
                // Мы не меняем стейт, чтобы студент мог нажать кнопку или ввести другой вопрос
                break;

            // -----------------------------------------------------
            // ГЛАВНОЕ МЕНЮ
            // -----------------------------------------------------
            case 'main_menu':
                if (user.role === 'operator') {
                    if (text === '📥 Очередь вопросов') {
                        const opCodeRes = await db.query('SELECT allowed_groups FROM operator_codes WHERE code = $1', [user.linked_code]);
                        const allowedGroups = opCodeRes.rows[0].allowed_groups;

                        const queueRes = await db.query(`
                            SELECT t.id, t.question, u.full_name, u.group_number 
                            FROM tickets t
                            JOIN users u ON t.student_vk_id = u.vk_id
                            WHERE t.status = 'open' AND u.group_number = ANY($1)
                            ORDER BY t.created_at ASC
                            LIMIT 5
                        `, [allowedGroups]);

                        if (queueRes.rows.length === 0) {
                            await context.send('Очередь пуста 🎉');
                        } else {
                            let msg = '📥 Очередь вопросов:\n';
                            let kb = Keyboard.builder();
                            queueRes.rows.forEach(t => {
                                msg += `\n🆔 #${t.id} [${t.full_name} ${t.group_number}]: ${t.question.substring(0, 50)}...`;
                                kb.textButton({ label: `Взять #${t.id}`, payload: { command: 'take_ticket', ticket_id: t.id }, color: Keyboard.POSITIVE_COLOR }).row();
                            });
                            await context.send({ message: msg, keyboard: kb.inline() });
                        }
                    } else if (text === '💬 Мои диалоги') {
                        const myChatsRes = await db.query(`
                            SELECT t.id, t.question, u.full_name, u.group_number 
                            FROM tickets t
                            JOIN users u ON t.student_vk_id = u.vk_id
                            WHERE t.status = 'active' AND t.operator_vk_id = $1
                        `, [senderId]);

                        if (myChatsRes.rows.length === 0) {
                            await context.send('У вас нет активных диалогов.');
                        } else {
                            let msg = '💬 Ваши активные диалоги:\n';
                            let kb = Keyboard.builder();
                            myChatsRes.rows.forEach(t => {
                                msg += `\n🆔 #${t.id} [${t.full_name}]: ${t.question.substring(0, 30)}...`;
                                kb.textButton({ label: `Перейти к #${t.id}`, payload: { command: 'open_chat', ticket_id: t.id }, color: Keyboard.PRIMARY_COLOR }).row();
                            });
                            await context.send({ message: msg, keyboard: kb.inline() });
                        }
                    } else if (text === '👤 Профиль') {
                        await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);
                        // Подтягиваем группы для отображения
                        const opRes = await db.query('SELECT allowed_groups FROM operator_codes WHERE code = $1', [user.linked_code]);
                        const groups = opRes.rows.length > 0 ? opRes.rows[0].allowed_groups.join(', ') : '';

                        await context.send({
                            message: `👤 Тьютор: ${user.full_name}\nГруппы: ${groups}`,
                            keyboard: Keyboard.builder()
                                .textButton({ label: '✏️ Редактировать', color: Keyboard.PRIMARY_COLOR })
                                .row()
                                .textButton({ label: '🏠 Главное меню', color: Keyboard.SECONDARY_COLOR })
                        });
                    } else {
                        await mainMenu(context, user); // Дефолтное меню
                    }
                }
                // --- СТУДЕНТ ---
                else if (user.role === 'student') {
                    if (text === '✉️ Задать вопрос') {
                        await db.query("UPDATE users SET state = 'ask_question_mode' WHERE vk_id = $1", [senderId]);
                        await context.send({
                            message: 'Напишите ваш вопрос:',
                            keyboard: Keyboard.builder().textButton({ label: '🏠 В меню', color: Keyboard.SECONDARY_COLOR }).oneTime()
                        });
                    } else if (text === '🗂 Мои обращения') {
                        const myTickets = await db.query(`
                            SELECT id, question, status, created_at FROM tickets 
                            WHERE student_vk_id = $1 ORDER BY created_at DESC LIMIT 5
                        `, [senderId]);

                        if (myTickets.rows.length === 0) {
                            await context.send('У вас нет обращений.');
                        } else {
                            let msg = '🗂 Ваши последние обращения:\n';
                            let kb = Keyboard.builder();
                            myTickets.rows.forEach(t => {
                                const statusEmoji = t.status === 'open' ? '⏳' : (t.status === 'active' ? '🔥' : '✅');
                                msg += `\n${statusEmoji} #${t.id}: ${t.question.substring(0, 30)}...`;
                                if (t.status === 'active') {
                                    kb.textButton({ label: `Перейти к #${t.id}`, payload: { command: 'open_chat', ticket_id: t.id }, color: Keyboard.POSITIVE_COLOR }).row();
                                }
                            });
                            await context.send({ message: msg, keyboard: kb.inline() });
                        }
                    } else if (text === '👤 Профиль') {
                        await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);

                        // Получаем имя тьютора
                        const tutorRes = await db.query('SELECT * FROM operator_codes WHERE $1 = ANY(allowed_groups)', [user.group_number]);
                        let tutorName = tutorRes.rows.length > 0 ? tutorRes.rows[0].tutor_name : 'Не назначен';

                        await context.send({
                            message: `👤 Студент: ${user.full_name}\nГруппа: ${user.group_number}\nТьютор: ${tutorName}`,
                            keyboard: Keyboard.builder()
                                .textButton({ label: '✏️ Редактировать', color: Keyboard.PRIMARY_COLOR })
                                .row()
                                .textButton({ label: '❌ Удалить профиль', color: Keyboard.NEGATIVE_COLOR })
                                .row()
                                .textButton({ label: '🏠 Главное меню', color: Keyboard.SECONDARY_COLOR })
                        });
                    } else {
                        await mainMenu(context, user);
                    }
                }
                break;
        }

    } catch (err) {
        console.error('🔥 CRITICAL ERROR:', err);
    }
});

// Вспомогательная функция для отправки Главного Меню
async function mainMenu(context, user) {
    if (user.role === 'operator') {
        await context.send({
            message: 'Меню тьютора:',
            keyboard: Keyboard.builder()
                .textButton({ label: '📥 Очередь вопросов', color: Keyboard.PRIMARY_COLOR })
                .row()
                .textButton({ label: '💬 Мои диалоги', color: Keyboard.PRIMARY_COLOR })
                .row()
                .textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
        });
    } else {
        await context.send({
            message: 'Меню студента:',
            keyboard: Keyboard.builder()
                .textButton({ label: '✉️ Задать вопрос', color: Keyboard.PRIMARY_COLOR })
                .row()
                .textButton({ label: '🗂 Мои обращения', color: Keyboard.PRIMARY_COLOR })
                .row()
                .textButton({ label: '👤 Профиль', color: Keyboard.SECONDARY_COLOR })
        });
    }
}

async function start() {
    await db.connect();
    console.log('📦 DB Connected');
    await vk.updates.start();
    console.log('🚀 Bot started');
}

start();