// Сверка названий VK-сообществ и автоматический перевод курса.
//
// Курсовое сообщество раз в год переименовывают: «Второй курс …» → «Третий курс …»,
// после четвёртого курса — «… Архив 25/26». Бот узнаёт об этом, сверяя название
// с VK, и сам переводит студентов этого сообщества на следующий курс или выпускает.
//
// Когда сверяется:
//   - по расписанию 1 августа и 1 сентября (переименовывают обычно в июле,
//     сентябрьская сверка — на случай, если переименовали позже);
//   - вручную кнопкой ↻ на странице «Группы VK».

const schedule = require('node-schedule');
const { VK } = require('vk-io');
const { db } = require('./database');
const { parseCommunityName, describeCommunity } = require('./courses');

// Часовой пояс университета: расписание не должно зависеть от пояса сервера (в Docker — UTC)
const UNIVERSITY_TZ = 'Asia/Yekaterinburg';

/** Название сообщества из VK. Для запущенного бота — его API, для выключенного — клиент по токену. */
async function fetchVkName(group) {
    const running = global.bots && global.bots[group.group_id];
    const api = running ? running.api : new VK({ token: group.access_token }).api;
    const res = await api.groups.getById({ group_id: group.group_id });
    // В разных версиях API VK ответ — массив или объект { groups: [...] }
    const list = Array.isArray(res) ? res : ((res && res.groups) || []);
    if (!list[0] || !list[0].name) throw new Error('VK не вернул название сообщества');
    return list[0].name;
}

/**
 * Что делать со студентами при смене названия.
 *   promote  — курс вырос ровно на 1: обычное ежегодное переименование
 *   graduate — сообщество ушло в архив: поток выпустился
 *   reopen   — архивное сообщество снова стало курсовым (отдали новому потоку):
 *              новый курс — точка отсчёта, прежние студенты уже выпускники
 *   anomaly  — курс сменился иначе (назад, через курс): скорее всего, опечатка
 *              в названии. Студентов не трогаем, курс сообщества оставляем прежним
 *   none     — сменилось только название, либо курс определён впервые
 */
function decideAction(before, after) {
    if (!before.archived && after.archived) return 'graduate';
    if (after.archived) return 'none';
    if (before.archived) return 'reopen';
    if (before.course && after.course) {
        if (after.course === before.course + 1) return 'promote';
        if (after.course !== before.course) return 'anomaly';
    }
    return 'none';
}

/**
 * Сверяет одно сообщество с VK и применяет перевод курса.
 * @param {object} group строка vk_groups
 * @param {object} [opts] fetchName — подменяется в тестах
 */
async function syncGroup(group, { fetchName = fetchVkName } = {}) {
    const newName = await fetchName(group);
    const before = { course: group.course, archived: Boolean(group.is_archived) };
    const after = parseCommunityName(newName);
    const action = decideAction(before, after);
    const label = `«${group.group_name}» (ID ${group.group_id})`;

    const result = { groupId: group.group_id, oldName: group.group_name, newName, before, after, action, changed: 0 };

    // При странной смене курса (3 → 1) оставляем прежний курс. Иначе проверка
    // при каждом сообщении студента (reconcileStudentCourse в bot.js) сверяла бы
    // группы с ошибочным курсом и «исправила» бы третьекурсников на первый курс.
    const courseToStore = action === 'anomaly' ? before.course : after.course;

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'UPDATE vk_groups SET group_name = $1, course = $2, is_archived = $3, name_synced_at = NOW() WHERE id = $4',
            [newName, courseToStore, after.archived, group.id]
        );

        if (action === 'promote') {
            // Ставим курс, а не прибавляем единицу: повторная сверка ничего не сломает,
            // а студенты, уже указавшие новый курс, не уедут на курс вперёд
            const res = await client.query(
                `UPDATE users
                    SET group_number = regexp_replace(group_number, '^([^-]+-)[0-9]', '\\1' || $2::text)
                  WHERE vk_group_id = $1
                    AND role = 'student'
                    AND NOT COALESCE(is_graduated, FALSE)
                    AND group_number ~ '^[^-]+-[0-9]'
                    AND substring(group_number from '^[^-]+-([0-9])') <> $2::text
                  RETURNING vk_id`,
                [group.group_id, after.course]
            );
            result.changed = res.rowCount;
        } else if (action === 'graduate') {
            const res = await client.query(
                `UPDATE users SET is_graduated = TRUE
                  WHERE vk_group_id = $1 AND role = 'student' AND NOT COALESCE(is_graduated, FALSE)
                  RETURNING vk_id`,
                [group.group_id]
            );
            result.changed = res.rowCount;
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    const nameNote = newName !== group.group_name ? ` → «${newName}»` : '';
    switch (action) {
        case 'promote':
            console.info(`[GROUPS] ${label}${nameNote}: курс ${before.course} → ${after.course}, переведено студентов: ${result.changed}`);
            break;
        case 'graduate':
            console.info(`[GROUPS] ${label}${nameNote}: сообщество ушло в архив, выпущено студентов: ${result.changed}`);
            break;
        case 'anomaly':
            console.warn(`[GROUPS] ${label}${nameNote}: необычная смена курса ${before.course} → ${after.course} — похоже на опечатку в названии. Студенты НЕ переведены, в боте оставлен прежний курс ${before.course}`);
            break;
        case 'reopen':
            console.info(`[GROUPS] ${label}${nameNote}: сообщество вернулось из архива, теперь ${describeCommunity(after)} (прежние студенты остаются выпускниками)`);
            break;
        default:
            if (nameNote) console.info(`[GROUPS] ${label}${nameNote}: название обновлено, ${describeCommunity(after)}`);
            else console.debug(`[GROUPS] ${label}: без изменений (${describeCommunity(after)})`);
    }
    return result;
}

/** Сверяет все сообщества. Ошибка одного не останавливает остальные. */
async function syncAllGroups(reason) {
    console.info(`[GROUPS] Сверка названий сообществ с VK: ${reason}`);
    const groups = await db.query('SELECT * FROM vk_groups ORDER BY id');
    const results = [];
    for (const group of groups.rows) {
        try {
            results.push(await syncGroup(group));
        } catch (err) {
            console.error(`[GROUPS] Не удалось сверить «${group.group_name}» (ID ${group.group_id}):`, err);
            results.push({ groupId: group.group_id, oldName: group.group_name, error: err.message });
        }
    }
    const promoted = results.reduce((n, r) => n + (r.action === 'promote' ? r.changed : 0), 0);
    const graduated = results.reduce((n, r) => n + (r.action === 'graduate' ? r.changed : 0), 0);
    const failed = results.filter(r => r.error).length;
    console.info(`[GROUPS] Сверка завершена: сообществ ${results.length}, переведено ${promoted}, выпущено ${graduated}${failed ? `, ошибок ${failed}` : ''}`);
    return results;
}

/** Плановые сверки: 1 августа и 1 сентября в 03:00 по Екатеринбургу */
function scheduleGroupSync() {
    const run = (reason) => () => syncAllGroups(reason).catch(err => console.error('[GROUPS] Плановая сверка прервана:', err));
    const aug = schedule.scheduleJob({ rule: '0 3 1 8 *', tz: UNIVERSITY_TZ }, run('плановая, 1 августа'));
    const sep = schedule.scheduleJob({ rule: '0 3 1 9 *', tz: UNIVERSITY_TZ }, run('плановая, 1 сентября'));
    // nextInvocation() отдаёт свой тип даты — приводим к обычному Date для вывода в нужном поясе
    const next = [aug, sep].map(j => j && j.nextInvocation()).filter(Boolean)
        .map(d => new Date(d.getTime())).sort((a, b) => a - b)[0];
    const when = next ? next.toLocaleString('ru-RU', { timeZone: UNIVERSITY_TZ, dateStyle: 'long', timeStyle: 'short' }) : 'не запланирована';
    console.info(`[GROUPS] Плановая сверка названий сообществ: 1 августа и 1 сентября, ближайшая — ${when}`);
}

module.exports = { syncGroup, syncAllGroups, scheduleGroupSync, _test: { decideAction } };
