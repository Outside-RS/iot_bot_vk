/**
 * Автоматический перевод на следующий курс
 * Запуск: 1 августа каждого года
 * 
 * Использование:
 * 1. Установить node-schedule: npm install node-schedule
 * 2. В index.js добавить: require('./jobs/course_promotion');
 */

const schedule = require('node-schedule');
const { db } = require('../database');

// Функция увеличения курса в номере группы (РИ-140944 -> РИ-240944)
function promoteCourse(groupNumber) {
    if (!groupNumber) return groupNumber;
    return groupNumber.replace(/^([А-Яа-яA-Za-z]+-?)(\d)/, (match, prefix, courseDigit) => {
        const newCourse = Math.min(parseInt(courseDigit) + 1, 9);
        return prefix + newCourse;
    });
}

// Основная функция перевода
async function promoteAllUsers() {
    console.log('🎓 [АВТО-ПЕРЕВОД] Запуск ежегодного перевода курса...');

    try {
        // 1. Переводим студентов
        const students = await db.query(`
            SELECT vk_id, group_number, study_years 
            FROM users 
            WHERE (is_graduated = FALSE OR is_graduated IS NULL)
        `);

        let promoted = 0;
        let graduated = 0;

        for (const user of students.rows) {
            const newGroup = promoteCourse(user.group_number);
            const courseMatch = newGroup ? newGroup.match(/-(\d)/) : null;
            const newCourse = courseMatch ? parseInt(courseMatch[1]) : 1;
            const studyYears = user.study_years || 4;

            if (newCourse > studyYears) {
                await db.query('UPDATE users SET group_number = $1, is_graduated = TRUE WHERE vk_id = $2', [newGroup, user.vk_id]);
                graduated++;
            } else {
                await db.query('UPDATE users SET group_number = $1 WHERE vk_id = $2', [newGroup, user.vk_id]);
                promoted++;
            }
        }

        // 2. Переводим группы тьюторов (с учетом max_course)
        const tutors = await db.query('SELECT code, allowed_groups, max_course FROM operator_codes');
        let tutorsUpdated = 0;

        for (const tutor of tutors.rows) {
            if (tutor.allowed_groups && tutor.allowed_groups.length > 0) {
                const maxCourse = tutor.max_course || 4;
                const newGroups = tutor.allowed_groups
                    .map(g => promoteCourse(g))
                    .filter(g => {
                        // Убираем группы, превысившие max_course
                        const courseMatch = g ? g.match(/-(\d)/) : null;
                        const course = courseMatch ? parseInt(courseMatch[1]) : 1;
                        return course <= maxCourse;
                    });
                await db.query('UPDATE operator_codes SET allowed_groups = $1 WHERE code = $2', [newGroups, tutor.code]);
                tutorsUpdated++;
            }
        }

        console.log(`✅ [АВТО-ПЕРЕВОД] Завершено!`);
        console.log(`   - Переведено студентов: ${promoted}`);
        console.log(`   - Выпущено: ${graduated}`);
        console.log(`   - Тьюторов обновлено: ${tutorsUpdated}`);

    } catch (err) {
        console.error('❌ [АВТО-ПЕРЕВОД] Ошибка:', err.message);
    }
}

// Расписание: 1 августа в 00:01
// Формат cron: секунда минута час день месяц деньНедели
const job = schedule.scheduleJob('1 0 1 8 *', promoteAllUsers);

console.log('📅 [АВТО-ПЕРЕВОД] Задача запланирована на 1 августа');

// Экспорт для ручного вызова (для тестов)
module.exports = { promoteAllUsers };
