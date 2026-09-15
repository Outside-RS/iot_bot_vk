// Поиск по базе знаний (уровень 1) и подготовка контекста для ИИ (уровень 2).
// Раньше этот SQL был продублирован в двух местах bot.js.
const { db } = require('./database');

// Пороги подобраны на реальной базе знаний (136 вопросов):
// правильные совпадения на вопросы «своими словами» набирают 0.108–0.284,
// шум и вопросы, ответа на которые в базе нет, — не выше 0.092.
const DIRECT_MIN_SCORE = 0.15; // показать ответ из базы сразу / кнопками
const HINT_MIN_SCORE = 0.1;    // передать ИИ как контекст
const MAX_HINTS = 5;

// Гибридный поиск:
// - plainto_tsquery + замена & на | — совпадение хотя бы по одному слову (ИЛИ);
// - ts_rank — ранжирование по частоте слов (вес 1.0);
// - similarity из pg_trgm — нечёткое сравнение, ловит опечатки (вес 0.5).
// Ищем только по вопросу и ключевым словам: ответ в поиске не участвует.
// Обе части считаются отдельно (lex и trgm), чтобы в логах было видно,
// за счёт чего нашлась запись: по словам или по похожести написания.
const SEARCH_SQL = `
    SELECT id, question, answer, lex, trgm, (lex * 1.0 + trgm * 0.5) AS score
    FROM (
        SELECT id, question, answer,
            ts_rank(search_vector, q) AS lex,
            similarity(question || ' ' || COALESCE(keywords, ''), $1) AS trgm,
            search_vector @@ q AS lex_match
        FROM faq, to_tsquery('russian', regexp_replace(plainto_tsquery('russian', $1)::text, '&', '|', 'g')) AS q
    ) t
    WHERE lex_match OR trgm > 0.1
    ORDER BY score DESC
    LIMIT $2
`;

const fmt = (n) => Number(n).toFixed(3);

async function searchFaq(text, limit = 8) {
    const started = Date.now();
    const res = await db.query(SEARCH_SQL, [text || '', limit]);
    const rows = res.rows.map(r => ({ ...r, score: Number(r.score), lex: Number(r.lex), trgm: Number(r.trgm) }));

    const top = rows.slice(0, 3)
        .map(r => `#${r.id} ${fmt(r.score)} (лексика ${fmt(r.lex)} + триграммы ${fmt(r.trgm)}×0.5)`)
        .join('; ');
    console.debug(`[SEARCH] «${String(text || '').replace(/\s+/g, ' ').slice(0, 80)}» → совпадений: ${rows.length} за ${Date.now() - started} мс${top ? `. Лучшие: ${top}` : ''}`);
    return rows;
}

/**
 * Контекст для ИИ — только записи выше порога.
 * Без порога в модель уходил шум: на вопрос, которого нет в базе, она получала
 * нерелевантные записи с инструкцией «это единственный источник» и выдумывала
 * ответ, подгоняя его под них. Пустой контекст честнее: промпт для этого
 * случая велит сказать, что в базе ответа нет.
 */
function buildHints(rows) {
    return rows
        .filter(r => r.score >= HINT_MIN_SCORE)
        .slice(0, MAX_HINTS)
        .map(r => `Вопрос: ${r.question}\nОтвет: ${r.answer}`)
        .join('\n---\n');
}

/** Объединяет результаты двух поисков: по id, с лучшим score */
function mergeRows(...lists) {
    const byId = new Map();
    for (const row of lists.flat()) {
        const prev = byId.get(row.id);
        if (!prev || row.score > prev.score) byId.set(row.id, row);
    }
    return [...byId.values()].sort((a, b) => b.score - a.score);
}

/**
 * Контекст для ИИ с учётом диалога.
 * Уточняющий вопрос вроде «а какая у неё почта?» сам по себе не содержит темы,
 * и поиск по нему одному не находит нужную запись. Поэтому дополнительно ищем
 * по предыдущему вопросу студента вместе с текущим и объединяем результаты.
 * Порог buildHints по-прежнему отсекает шум.
 *
 * @param {string} text  текущий вопрос
 * @param {Array}  rows  результаты поиска по текущему вопросу (уже есть у вызывающего)
 * @param {Array}  history  ai_context пользователя — БЕЗ текущего вопроса
 */
async function buildDialogHints(text, rows, history = []) {
    const prevUser = [...(history || [])].reverse().find(m => m.role === 'user');
    if (!prevUser) return buildHints(rows);

    const dialogRows = await searchFaq(`${prevUser.content} ${text}`, 8);
    return buildHints(mergeRows(rows, dialogRows));
}

// Весь текст базы знаний — источник проверенных контактов для fact_guard.js.
// Контакт считается настоящим, если он есть где-либо в базе, а не только в
// переданном модели контексте. Кэш на 5 минут: правки из админки подхватятся
// с небольшой задержкой, зато база не читается целиком на каждый ответ.
const FAQ_TEXT_TTL = 5 * 60 * 1000;
let faqTextCache = null;
let faqTextCachedAt = 0;

async function getAllFaqText() {
    if (faqTextCache !== null && Date.now() - faqTextCachedAt < FAQ_TEXT_TTL) {
        return faqTextCache;
    }
    const res = await db.query('SELECT question, answer FROM faq');
    faqTextCache = res.rows.map(r => `${r.question}\n${r.answer}`).join('\n');
    faqTextCachedAt = Date.now();
    return faqTextCache;
}

module.exports = {
    searchFaq, buildHints, buildDialogHints, mergeRows, getAllFaqText,
    DIRECT_MIN_SCORE, HINT_MIN_SCORE
};
