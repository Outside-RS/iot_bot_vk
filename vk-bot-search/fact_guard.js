// Фильтр непроверенных фактов в ответах ИИ.
//
// Промпт просит модель не выдумывать, но гарантии это не даёт: 04.09.2026
// GigaChat выдал студенту несуществующий адрес dekanat-rtf@urfu.ru.
// Поэтому после генерации каждый контакт из ответа (почта, ссылка, телефон,
// аудитория) сверяется с проверенными источниками: базой знаний и сообщениями
// самого студента. Неподтверждённый контакт заменяется пометкой.
//
// Ограничение: фильтр ловит только контакты. Выдуманные ФИО, сроки и суммы
// он не распознаёт — от них защищает промпт и порог контекста в faq_search.js.

const PLACEHOLDER = '[уточните у администратора]';
const NOTE = '⚠️ Часть контактов не подтверждена базой знаний. Точные данные подскажет администратор — кнопка «👨‍💼 Передать администратору».';

const CYR = 'А-Яа-яЁё';

// Латинские буквы, похожие на кириллические: модель может написать «P-219» латиницей
const LOOKALIKE = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };

const PATTERNS = {
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    url: /(?:https?:\/\/)?(?:www\.)?(?:[A-Za-z0-9-]+\.)+(?:ru|рф|com|org|net|io|su|me)(?:\/[^\s,;)»"'<>]*)?/gi,
    // +7 (343) 375-44-80, 8 343 375 44 80, 375-44-80
    phone: /(?:\+7|(?<!\d)8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)|(?<![\d-])\d{3}-\d{2}-\d{2}(?![\d-])/g,
    // «ауд. Р-219», «аудитории Р-138А», «кабинет 119», а также код корпуса без слова: «в Р-219»
    room: new RegExp(
        `(?:(?:ауд\\.?|аудитори[${CYR}]*|кабинет[${CYR}]*|каб\\.)\\s*№?\\s*((?:[${CYR}A-Z]-?)?\\d{2,4}[${CYR}A-Z]?)` +
        `|(?<![${CYR}A-Za-z0-9-])([${CYR}A-Z]-\\d{3}[${CYR}A-Z]?)(?![0-9${CYR}]))`,
        'gi'
    )
};

function normalize(type, raw) {
    switch (type) {
        case 'email':
            return raw.toLowerCase();
        case 'url':
            return raw.toLowerCase()
                .replace(/^https?:\/\//, '')
                .replace(/^www\./, '')
                .replace(/[.,;:!?)»]+$/, '')
                .replace(/\/+$/, '');
        case 'phone': {
            const digits = raw.replace(/\D/g, '');
            return digits.slice(-7); // сравниваем по местному номеру
        }
        case 'room':
            return raw.toUpperCase()
                .replace(/[A-Z]/g, ch => LOOKALIKE[ch] || ch)
                .replace(/[\s-]/g, '');
        default:
            return raw;
    }
}

/** Находит в тексте все контакты. Возвращает [{ type, raw, key }] */
function extractFacts(text) {
    const facts = [];
    let rest = text || '';

    // Сначала почта: иначе её доменная часть распознается ещё и как ссылка
    rest = rest.replace(PATTERNS.email, (raw) => {
        facts.push({ type: 'email', raw, key: normalize('email', raw) });
        return ' ';
    });

    rest = rest.replace(PATTERNS.url, (raw) => {
        const clean = raw.replace(/[.,;:!?)»]+$/, '');
        facts.push({ type: 'url', raw: clean, key: normalize('url', clean) });
        return ' ';
    });

    for (const m of rest.matchAll(PATTERNS.phone)) {
        facts.push({ type: 'phone', raw: m[0], key: normalize('phone', m[0]) });
    }

    for (const m of rest.matchAll(PATTERNS.room)) {
        const code = m[1] || m[2];
        facts.push({ type: 'room', raw: code, key: normalize('room', code) });
    }

    return facts;
}

/** Собирает проверенные факты из доверенных текстов */
function buildKnownFacts(...texts) {
    const known = { email: new Set(), url: new Set(), domain: new Set(), phone: new Set(), room: new Set() };
    for (const text of texts) {
        for (const f of extractFacts(text)) {
            known[f.type].add(f.key);
            if (f.type === 'url') known.domain.add(f.key.split('/')[0]);
        }
    }
    return known;
}

function isKnown(fact, known) {
    if (fact.type === 'url') {
        if (known.url.has(fact.key)) return true;
        // Голый домен (без пути) допустим, если на нём есть проверенная ссылка:
        // «urfu.ru» при известной «urfu.ru/ru/international/». А вот выдуманный
        // путь на известном домене — нет: это типичная галлюцинация.
        const isBareDomain = !fact.key.includes('/');
        return isBareDomain && known.domain.has(fact.key);
    }
    return known[fact.type].has(fact.key);
}

/**
 * Проверяет ответ модели. Неподтверждённые контакты заменяет пометкой
 * и добавляет в конец пояснение.
 * @returns {{ text: string, removed: string[] }}
 */
function guardFacts(text, known) {
    const unverified = extractFacts(text).filter(f => !isKnown(f, known));
    if (unverified.length === 0) return { text, removed: [] };

    let guarded = text;
    // Длинные сначала, чтобы не зацепить часть другого контакта
    const raws = [...new Set(unverified.map(f => f.raw))].sort((a, b) => b.length - a.length);
    for (const raw of raws) {
        guarded = guarded.split(raw).join(PLACEHOLDER);
    }

    return { text: `${guarded.trim()}\n\n${NOTE}`, removed: raws };
}

module.exports = { extractFacts, buildKnownFacts, guardFacts, PLACEHOLDER, NOTE };
