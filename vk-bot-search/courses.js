// Курс студента по названию VK-сообщества.
//
// Источник истины — сообщество, а не цифра в номере группы: вступление
// в курсовое сообщество модерируется, а номер группы студент вводит сам
// и может ошибиться. Сообщество «идёт» вместе со своим потоком и раз в год
// переименовывается: «Второй курс …» → «Третий курс …». После четвёртого
// курса оно уходит в архив: «Четвертый курс ИОТ, УрФУ - Архив 25/26».
//
// Реальные названия (сентябрь 2026):
//   Первый курс ИРИТ-РТФ УрФУ
//   Второй курс Бакалавриат ИРИТ УрФУ
//   Третий курс ИОТ ИРИТ УрФУ
//   Четвертый курс ИОТ ИРИТ-РТФ УрФУ

// Бакалавриат — 4 года. Курс выше считается ошибкой разбора.
const MAX_COURSE = 4;

const ORDINALS = [
    [/^перв/i, 1],
    [/^втор/i, 2],
    [/^трет/i, 3],
    [/^четв[её]рт/i, 4],
    [/^пят/i, 5],
    [/^шест/i, 6]
];

/**
 * «Второй курс Бакалавриат ИРИТ УрФУ» → { course: 2, archived: false }
 * «Четвертый курс ИОТ, УрФУ - Архив 25/26» → { course: 4, archived: true }
 * Название без курса в начале (например тестовое «bot-IOT-test») → { course: null, archived: false }
 */
function parseCommunityName(name) {
    const text = String(name || '').trim();
    const archived = /архив/i.test(text);

    // Курс словом: «Второй курс», «Четвёртый курс» / «Четвертый курс»
    const word = text.match(/^([А-Яа-яЁё]+)\s+курс/i);
    if (word) {
        const hit = ORDINALS.find(([re]) => re.test(word[1]));
        if (hit && hit[1] <= MAX_COURSE) return { course: hit[1], archived };
    }

    // На всякий случай — курс цифрой: «2 курс», «2-й курс»
    const digit = text.match(/^(\d)\s*(?:-?\s*(?:й|ый|ой|ий))?\s+курс/i);
    if (digit) {
        const n = Number(digit[1]);
        if (n >= 1 && n <= MAX_COURSE) return { course: n, archived };
    }

    return { course: null, archived };
}

/** «РИ-240944» → 2 (первая цифра после дефиса) */
function courseOfGroup(groupNumber) {
    const m = String(groupNumber || '').match(/^[А-ЯЁA-Z]+-(\d)/i);
    return m ? Number(m[1]) : null;
}

/** «РИ-140944», 2 → «РИ-240944». Ставит курс, а не прибавляет единицу — повтор безопасен. */
function withCourse(groupNumber, course) {
    return String(groupNumber).replace(/^([А-ЯЁA-Z]+-)\d/i, `$1${course}`);
}

/** «Второй курс …» → «2 курс» / «архив» / «курс не определён» — для экранов и логов */
function describeCommunity({ course, archived }) {
    if (archived) return course ? `архив (${course} курс)` : 'архив';
    return course ? `${course} курс` : 'курс не определён';
}

module.exports = { parseCommunityName, courseOfGroup, withCourse, describeCommunity, MAX_COURSE };
