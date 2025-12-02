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

// Хелпер для красивых логов
const log = (emoji, msg) => console.log(`${emoji} [${new Date().toLocaleTimeString()}] ${msg}`);

// Regex для валидации
const REGEX_FIO = /^[А-Яа-яЁё]+\s+[А-Яа-яЁё]+.*$/; // Минимум 2 слова на кириллице
const REGEX_GROUP = /^[А-Я]{2,}-\d{6}$/; // Пример: РИ-140944

vk.updates.on('message_new', async (context) => {
    if (context.isOutbox) return;
    const { text, senderId, messagePayload } = context;

    if (!text && !messagePayload) return;

    try {
        log('📩', `Сообщение от ${senderId}: "${text || '[Payload]'}"`);

        // 1. ПРОВЕРКА PAYLOAD (Нажатие кнопок)
        if (messagePayload) {
            // --- ВЗЯТИЕ ТИКЕТА ---
            if (messagePayload.command === 'take_ticket') {
                const ticketId = messagePayload.ticket_id;
                const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
                if (ticketRes.rows.length === 0) return context.send('Тикет не найден.');
                if (ticketRes.rows[0].status !== 'open') return context.send('Этот тикет уже кто-то взял или он закрыт.');

                const ticket = ticketRes.rows[0];
                await db.query("UPDATE tickets SET operator_vk_id = $1, status = 'active' WHERE id = $2", [senderId, ticketId]);
                await db.query("UPDATE users SET active_ticket_id = $1, state = 'chat_mode' WHERE vk_id = $2", [ticketId, senderId]);
                await db.query("UPDATE users SET active_ticket_id = $1, state = 'chat_mode' WHERE vk_id = $2", [ticketId, ticket.student_vk_id]);

                await context.send(`Вы взяли заявку! Студент: ${ticket.question}\n\nПишите ответ, я перешлю.`);
                await vk.api.messages.send({
                    peer_id: ticket.student_vk_id,
                    message: '👨‍💻 К диалогу подключился тьютор. Можете задавать уточняющие вопросы.',
                    random_id: 0
                });
                return;
            }

            // --- ПОДТВЕРЖДЕНИЕ ОТПРАВКИ ВОПРОСА ---
            if (messagePayload.command === 'confirm_send') {
                const questionText = messagePayload.question;

                // Получаем данные пользователя для уведомления
                let userRes = await db.query('SELECT * FROM users WHERE vk_id = $1', [senderId]);
                let user = userRes.rows[0];

                // Создаем тикет
                const newTicket = await db.query(
                    "INSERT INTO tickets (student_vk_id, question) VALUES ($1, $2) RETURNING id",
                    [senderId, questionText]
                );
                const ticketId = newTicket.rows[0].id;

                await context.send({
                    message: 'Ваш вопрос передан тьютору, ожидайте ответа.',
                    keyboard: Keyboard.builder()
                        .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                        .oneTime()
                });

                // Ищем тьюторов
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
                            message: `🆘 Новый вопрос от ${user.full_name} (${user.group_number}):\n"${questionText}"`,
                            random_id: 0,
                            keyboard: Keyboard.builder()
                                .textButton({
                                    label: 'Взять вопрос',
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

        // 2. ПОЛУЧАЕМ ПОЛЬЗОВАТЕЛЯ
        let userRes = await db.query('SELECT * FROM users WHERE vk_id = $1', [senderId]);
        let user = userRes.rows[0];

        // 3. ЕСЛИ НЕТ - РЕГИСТРАЦИЯ
        if (!user) {
            log('👤', `Новый пользователь ${senderId}`);
            await db.query('INSERT INTO users (vk_id, state) VALUES ($1, $2)', [senderId, 'registration_start']);
            await context.send({
                message: 'Добро пожаловать! Кто вы?',
                keyboard: Keyboard.builder()
                    .textButton({ label: 'Я Студент', payload: { command: 'student' }, color: Keyboard.PRIMARY_COLOR })
                    .textButton({ label: 'Я Оператор', payload: { command: 'operator' }, color: Keyboard.POSITIVE_COLOR })
                    .oneTime()
            });
            return;
        }

        // 4. МАШИНА СОСТОЯНИЙ
        log('🔄', `State юзера ${senderId}: ${user.state}`);

        switch (user.state) {
            // --- РЕЖИМ ЧАТА (СВЯЗЬ ОПЕРАТОР-СТУДЕНТ) ---
            case 'chat_mode':
                if (!user.active_ticket_id) {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    return context.send('Ошибка сессии. Возврат в меню.');
                }
                if (user.role === 'operator' && text === '/close') {
                    await db.query("UPDATE tickets SET status = 'closed' WHERE id = $1", [user.active_ticket_id]);
                    await db.query("UPDATE users SET state = 'main_menu', active_ticket_id = NULL WHERE active_ticket_id = $1", [user.active_ticket_id]);
                    await context.send('Диалог завершен. Тикет закрыт.');
                    return;
                }
                const currentTicketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [user.active_ticket_id]);
                const currentTicket = currentTicketRes.rows[0];
                let targetId = (senderId == currentTicket.student_vk_id) ? currentTicket.operator_vk_id : currentTicket.student_vk_id;

                if (targetId) {
                    try {
                        let msgToSend = text;
                        // Если пишет студент -> добавляем подпись для оператора
                        if (user.role === 'student') {
                            msgToSend = `👤 [${user.full_name} ${user.group_number}]: ${text}`;
                        }

                        await vk.api.messages.send({
                            peer_id: targetId,
                            message: msgToSend,
                            random_id: 0
                        });
                    } catch (e) { }
                }
                break;

            // --- РЕГИСТРАЦИЯ ---
            case 'registration_start':
                if (text === 'Я Студент') {
                    await db.query("UPDATE users SET state = 'reg_student_fio' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Введите ваше ФИО (Фамилия Имя, отчество если есть):',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                } else if (text === 'Я Оператор') {
                    await db.query("UPDATE users SET state = 'reg_operator_code' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Введите секретный код доступа:',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
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
                            .textButton({ label: 'Я Оператор', color: Keyboard.POSITIVE_COLOR })
                            .oneTime()
                    });
                }

                if (!REGEX_FIO.test(text)) {
                    return context.send('⚠️ Ошибка: Введите Фамилию и Имя кириллицей (минимум 2 слова). Например: "Иванов Иван".');
                }

                await db.query("UPDATE users SET full_name = $1, state = 'reg_student_group' WHERE vk_id = $2", [text, senderId]);
                await context.send({
                    message: 'Отлично! Теперь введите вашу группу (например: РИ-140944):',
                    keyboard: Keyboard.builder()
                        .textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                        .oneTime()
                });
                break;

            case 'reg_student_group':
                if (text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'reg_student_fio' WHERE vk_id = $1", [senderId]);
                    return context.send({
                        message: 'Введите ваше ФИО (Фамилия Имя, отчество если есть):',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                }

                const group = text.toUpperCase();
                if (!REGEX_GROUP.test(group)) {
                    return context.send('⚠️ Ошибка: Формат группы должен быть "Буквы-Цифры" (например "РИ-140944").');
                }

                // Проверка тьютора
                const tutorRes = await db.query('SELECT * FROM operator_codes WHERE $1 = ANY(allowed_groups)', [group]);
                let tutorMsg = '';
                if (tutorRes.rows.length > 0) {
                    tutorMsg = `Ваш тьютор: ${tutorRes.rows[0].tutor_name}`;
                } else {
                    tutorMsg = `⚠️ Внимание: Для группы ${group} пока нет назначенного тьютора. Вы можете зарегистрироваться, но вопросы могут не доходить.`;
                }

                await db.query("UPDATE users SET group_number = $1, role = 'student', state = 'main_menu' WHERE vk_id = $2", [group, senderId]);
                await context.send({
                    message: `Готово! Вы зарегистрированы как студент.\n${tutorMsg}\n\nЗадавайте вопросы!`,
                    keyboard: Keyboard.builder()
                        .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                        .oneTime()
                });
                break;

            case 'reg_operator_code':
                if (text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'registration_start' WHERE vk_id = $1", [senderId]);
                    return context.send({
                        message: 'Кто вы?',
                        keyboard: Keyboard.builder()
                            .textButton({ label: 'Я Студент', color: Keyboard.PRIMARY_COLOR })
                            .textButton({ label: 'Я Оператор', color: Keyboard.POSITIVE_COLOR })
                            .oneTime()
                    });
                }

                const codeRes = await db.query('SELECT * FROM operator_codes WHERE code = $1', [text]);
                if (codeRes.rows.length > 0) {
                    const opData = codeRes.rows[0];
                    await db.query("UPDATE users SET role = 'operator', full_name = $1, linked_code = $2, state = 'main_menu' WHERE vk_id = $3",
                        [opData.tutor_name, text, senderId]);
                    await context.send({
                        message: `Успех! Вы курируете: ${opData.allowed_groups.join(', ')}`,
                        keyboard: Keyboard.builder()
                            .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                            .oneTime()
                    });
                } else {
                    await context.send({
                        message: 'Неверный код. Попробуйте еще раз или нажмите Назад.',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                }
                break;

            // --- РЕДАКТИРОВАНИЕ ПРОФИЛЯ ---
            case 'edit_student_fio':
                if (text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);
                    // Показываем профиль (дублируем логику profile_view)
                    // Для простоты вернем в main_menu и нажмем профиль
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    return context.send({
                        message: 'Редактирование отменено.',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                            .oneTime()
                    });
                }

                if (!REGEX_FIO.test(text)) {
                    return context.send('⚠️ Ошибка: Введите Фамилию и Имя кириллицей (минимум 2 слова).');
                }

                await db.query("UPDATE users SET full_name = $1, state = 'main_menu' WHERE vk_id = $2", [text, senderId]);
                await context.send({
                    message: '✅ ФИО успешно обновлено!',
                    keyboard: Keyboard.builder()
                        .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                        .oneTime()
                });
                break;

            case 'edit_student_group':
                if (text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    return context.send({
                        message: 'Редактирование отменено.',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                            .oneTime()
                    });
                }

                const newGroup = text.toUpperCase();
                if (!REGEX_GROUP.test(newGroup)) {
                    return context.send('⚠️ Ошибка: Формат группы должен быть "Буквы-Цифры" (например "РИ-140944").');
                }

                // Проверка тьютора
                const tRes = await db.query('SELECT * FROM operator_codes WHERE $1 = ANY(allowed_groups)', [newGroup]);
                let tMsg = '';
                if (tRes.rows.length > 0) {
                    tMsg = `Ваш новый тьютор: ${tRes.rows[0].tutor_name}`;
                } else {
                    tMsg = `⚠️ Внимание: Для группы ${newGroup} пока нет назначенного тьютора.`;
                }

                await db.query("UPDATE users SET group_number = $1, state = 'main_menu' WHERE vk_id = $2", [newGroup, senderId]);
                await context.send({
                    message: `✅ Группа обновлена!\n${tMsg}`,
                    keyboard: Keyboard.builder()
                        .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                        .oneTime()
                });
                break;

            // --- ПРОФИЛЬ ---
            case 'profile_view':
                if (text === '✏️ Редактировать') {
                    await db.query("UPDATE users SET state = 'profile_edit_select' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Что хотите изменить?',
                        keyboard: Keyboard.builder()
                            .textButton({ label: 'Изменить ФИО', color: Keyboard.PRIMARY_COLOR })
                            .textButton({ label: 'Изменить Группу', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                } else if (text === '✏️ Изменить данные') { // Для оператора
                    await context.send({
                        message: 'Данные оператора меняются только через перерегистрацию с новым кодом. Удалить профиль?',
                        keyboard: Keyboard.builder()
                            .textButton({ label: 'Да, удалить', color: Keyboard.NEGATIVE_COLOR })
                            .textButton({ label: 'Нет, оставить', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                    await db.query("UPDATE users SET state = 'profile_delete_confirm' WHERE vk_id = $1", [senderId]);
                } else if (text === '❌ Удалить профиль') {
                    await db.query("UPDATE users SET state = 'profile_delete_confirm' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Вы уверены, что хотите удалить профиль? Это действие нельзя отменить.',
                        keyboard: Keyboard.builder()
                            .textButton({ label: 'Да, удалить', color: Keyboard.NEGATIVE_COLOR })
                            .textButton({ label: 'Нет, оставить', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                } else if (text === '🏠 Главное меню' || text === '🔙 Назад') {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Главное меню',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                            .oneTime()
                    });
                } else {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    await context.send('Возврат в меню.');
                }
                break;

            case 'profile_edit_select':
                if (text === 'Изменить ФИО') {
                    await db.query("UPDATE users SET state = 'edit_student_fio' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Введите новое ФИО (Фамилия Имя):',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                } else if (text === 'Изменить Группу') {
                    await db.query("UPDATE users SET state = 'edit_student_group' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Введите новую группу:',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '🔙 Назад', color: Keyboard.SECONDARY_COLOR })
                            .oneTime()
                    });
                } else {
                    await db.query("UPDATE users SET state = 'main_menu' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Отмена редактирования.',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                            .oneTime()
                    });
                }
                break;

            case 'profile_delete_confirm':
                if (text === 'Да, удалить') {
                    await db.query('DELETE FROM users WHERE vk_id = $1', [senderId]);
                    await context.send({
                        message: 'Профиль удален. Напишите что-нибудь для новой регистрации.',
                        keyboard: Keyboard.builder().initial(false)
                    });
                } else {
                    await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);
                    await context.send({
                        message: 'Удаление отменено.',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '🏠 Главное меню', color: Keyboard.PRIMARY_COLOR })
                            .oneTime()
                    });
                }
                break;

            // --- ГЛАВНОЕ МЕНЮ ---
            case 'main_menu':
                if (text === '👤 Профиль') {
                    await db.query("UPDATE users SET state = 'profile_view' WHERE vk_id = $1", [senderId]);

                    let profileMsg = '';
                    let kb = Keyboard.builder();

                    if (user.role === 'student') {
                        // Ищем тьютора
                        const tutorRes = await db.query('SELECT * FROM operator_codes WHERE $1 = ANY(allowed_groups)', [user.group_number]);
                        const tutorName = tutorRes.rows.length > 0 ? tutorRes.rows[0].tutor_name : 'Не назначен';

                        profileMsg = `👤 Ваш профиль:\n\nФИО: ${user.full_name}\nГруппа: ${user.group_number}\nТьютор: ${tutorName}`;

                        kb.textButton({ label: '✏️ Редактировать', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: '❌ Удалить профиль', color: Keyboard.NEGATIVE_COLOR })
                            .row()
                            .textButton({ label: '🏠 Главное меню', color: Keyboard.SECONDARY_COLOR });
                    } else {
                        // Оператор
                        const opRes = await db.query('SELECT * FROM operator_codes WHERE code = $1', [user.linked_code]);
                        const groups = opRes.rows.length > 0 ? opRes.rows[0].allowed_groups.join(', ') : 'Нет данных';

                        // НЕ показываем код
                        profileMsg = `👤 Профиль Оператора:\n\nФИО: ${user.full_name}\nГруппы: ${groups}`;

                        kb.textButton({ label: '✏️ Изменить данные', color: Keyboard.PRIMARY_COLOR })
                            .row()
                            .textButton({ label: '🏠 Главное меню', color: Keyboard.SECONDARY_COLOR });
                    }

                    await context.send({
                        message: profileMsg,
                        keyboard: kb.oneTime()
                    });
                    return;
                }

                // ... (Логика поиска и тикетов)
                if (user.role === 'student') {
                    const faqQuery = `
                        SELECT answer, ts_rank_cd(search_vector, plainto_tsquery('russian', $1)) as rank
                        FROM faq
                        WHERE search_vector @@ plainto_tsquery('russian', $1)
                        ORDER BY rank DESC LIMIT 1;
                    `;
                    const faqRes = await db.query(faqQuery, [text]);

                    if (faqRes.rows.length > 0) {
                        await context.send({
                            message: faqRes.rows[0].answer,
                            keyboard: Keyboard.builder()
                                .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                                .oneTime()
                        });
                    } else {
                        // НЕ создаем тикет сразу. Спрашиваем подтверждение.
                        await context.send({
                            message: 'Ответ не найден. Хотите отправить вопрос тьютору?',
                            keyboard: Keyboard.builder()
                                .textButton({
                                    label: '✉️ Передать вопрос тьютору',
                                    payload: { command: 'confirm_send', question: text.substring(0, 200) }, // Обрезаем если слишком длинный
                                    color: Keyboard.POSITIVE_COLOR
                                })
                                .row()
                                .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                                .oneTime()
                        });
                    }
                } else {
                    await context.send({
                        message: 'Ждем вопросов...',
                        keyboard: Keyboard.builder()
                            .textButton({ label: '👤 Профиль', color: Keyboard.PRIMARY_COLOR })
                            .oneTime()
                    });
                }
                break;
        }

    } catch (err) {
        console.error('🔥 CRITICAL ERROR:', err);
    }
});

async function start() {
    await db.connect();
    console.log('📦 DB Connected');
    await vk.updates.start();
    console.log('🚀 Bot started');
}

start();