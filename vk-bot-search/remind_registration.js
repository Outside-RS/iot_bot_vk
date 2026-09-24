// Напоминание тем, кто начал общение с ботом, но не завершил регистрацию.
//
//   node remind_registration.js            — показать, кому написали бы (ничего не отправляет)
//   node remind_registration.js --send     — отправить
//   node remind_registration.js --send --days 30   — только тем, кто писал за последние 30 дней
//
// Зачем. Бот не может написать человеку первым — ВКонтакте это запрещает. Но
// тем, кто сам писал в сообщество, отвечать можно. Этим скрипт и пользуется:
// шлёт сообщение от имени того сообщества, в котором человек писал.
//
// Повод, по которому скрипт появился: ветка «Кто вы?» не отвечала на текст,
// введённый вместо нажатия кнопки, и человек оставался в диалоге без кнопок.
// Ошибку исправили, но сами эти люди об этом не узнают, пока не напишут снова.
//
// У кого сообщество не записано — это те, кто писал боту до сентября 2026, когда
// сообщество запоминалось только после полной регистрации. Таким скрипт
// пробует написать от каждого сообщества по очереди: ВКонтакте пропустит только
// то, которому человек писал сам. Найденное сообщество записывается в базу,
// чтобы второй раз не перебирать.
//
// Скрипт безопасно запускать повторно. Людям приходят сообщения, поэтому по
// умолчанию он только показывает список.
require('dotenv').config({ quiet: true });
const { VK, Keyboard } = require('vk-io');
const { db } = require('./database');

const SEND = process.argv.includes('--send');

// Состояния, в которых человек ещё не прошёл регистрацию до конца
const REGISTRATION_STATES = ['registration_start', 'reg_student_fio', 'reg_student_group', 'reg_operator_code'];

// Признак незавершённой регистрации.
//
// По роли определять нельзя, хотя так и просится: в схеме у users стоит
// DEFAULT 'student', и новый человек получает роль студента сразу при первом
// сообщении — ещё до того, как ответит на вопрос «Кто вы?». Проверка role IS
// NULL не находила никого, и скрипт молча сообщал, что напоминать некому.
//
// Надёжный признак — отсутствие имени: студент вводит ФИО сам, администратору
// имя подставляется из кода доступа. Плюс те, кто прямо сейчас застрял на
// одном из шагов регистрации. Администраторов не трогаем: если у кого-то из
// них нет имени, это вопрос кода доступа, а не регистрации.
const UNFINISHED = `role IS DISTINCT FROM 'operator'
      AND (full_name IS NULL OR state = ANY($1::text[]))`;

// Пауза между отправками: ВКонтакте ограничивает частоту обращений к API,
// а спешить здесь некуда
const PAUSE_MS = 300;

const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? Number.parseInt(process.argv[daysArg + 1], 10) : null;

const TEXT = 'Здравствуйте! Вы писали боту поддержки, но регистрация осталась незавершённой — возможно, из-за ошибки в боте: он мог не ответить на сообщение. Ошибку исправили. Давайте продолжим.';

const keyboard = Keyboard.builder()
    .textButton({ label: 'Я Студент', payload: { command: 'student' }, color: Keyboard.PRIMARY_COLOR })
    .textButton({ label: 'Я Администратор', payload: { command: 'operator' }, color: Keyboard.POSITIVE_COLOR })
    .oneTime();

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    // Сообщества с токенами: писать человеку нужно от имени того, куда он писал
    const groups = await db.query('SELECT group_id, group_name, access_token FROM vk_groups WHERE is_active = TRUE');
    const byGroup = new Map(groups.rows.map(g => [String(g.group_id), g]));

    const where = [UNFINISHED];
    const params = [REGISTRATION_STATES];
    if (Number.isInteger(DAYS) && DAYS > 0) {
        params.push(DAYS);
        where.push(`created_at > NOW() - ($${params.length} || ' days')::interval`);
    }
    const users = await db.query(
        `SELECT vk_id, vk_group_id, created_at FROM users WHERE ${where.join(' AND ')} ORDER BY created_at`,
        params
    );

    if (users.rows.length === 0) {
        console.log('Незавершённых регистраций нет.');
        return;
    }

    console.log(`Незавершённых регистраций: ${users.rows.length}${DAYS ? ` (за последние ${DAYS} дн.)` : ''}`);
    if (!SEND) console.log('Это предварительный просмотр. Чтобы отправить, добавьте --send\n');

    const clients = new Map();
    let sent = 0, failed = 0, skipped = 0;

    for (const u of users.rows) {
        const group = byGroup.get(String(u.vk_group_id));
        const when = new Date(u.created_at).toLocaleDateString('ru-RU');

        // Сообщество известно — пишем от него. Неизвестно — перебираем все:
        // лишние попытки ничего не стоят, ВКонтакте просто откажет
        const candidates = group ? [group] : groups.rows;

        if (candidates.length === 0) {
            console.log(`  ${u.vk_id} (${when}) — пропуск: нет ни одного подключённого сообщества`);
            skipped++;
            continue;
        }

        if (!SEND) {
            const from = group
                ? `от «${group.group_name}»`
                : `перебором, сообществ: ${candidates.length}`;
            console.log(`  ${u.vk_id} (${when}) — написали бы ${from}`);
            continue;
        }

        let ok = null;
        let lastError = '';
        for (const c of candidates) {
            if (!clients.has(c.group_id)) clients.set(c.group_id, new VK({ token: c.access_token }));
            try {
                await clients.get(c.group_id).api.messages.send({
                    peer_id: Number(u.vk_id), random_id: 0, message: TEXT, keyboard
                });
                ok = c;
                break;
            } catch (err) {
                // Код 901 — человек не писал этому сообществу или запретил ему
                // писать. При переборе это ожидаемо: подходит только одно
                lastError = err.message;
            }
            await pause(PAUSE_MS);
        }

        if (ok) {
            console.log(`  ${u.vk_id} — отправлено от «${ok.group_name}»`);
            sent++;
            // Запоминаем найденное сообщество: в следующий раз перебирать не придётся,
            // да и бот будет знать, откуда с человеком разговаривать
            if (!group) {
                await db.query('UPDATE users SET vk_group_id = $1 WHERE vk_id = $2 AND vk_group_id IS NULL', [ok.group_id, u.vk_id]);
            }
        } else {
            console.log(`  ${u.vk_id} — не доставлено: ${lastError}`);
            failed++;
        }
        await pause(PAUSE_MS);
    }

    if (SEND) {
        console.log(`\nОтправлено: ${sent}, не доставлено: ${failed}, пропущено: ${skipped}`);
        if (failed > 0) console.log('Не доставлено обычно означает, что человек запретил сообщения от сообщества.');
    }
}

if (require.main === module) {
    main()
        .catch(err => {
            console.error('Ошибка:', err.message);
            process.exitCode = 1;
        })
        .finally(() => db.end());
}

module.exports = { UNFINISHED, REGISTRATION_STATES };
