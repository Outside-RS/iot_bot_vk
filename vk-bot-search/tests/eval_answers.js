/**
 * Контрольные вопросы для проверки качества ответов ИИ.
 *
 * В отличие от test_all.js, обращается к НАСТОЯЩЕЙ модели GigaChat, поэтому
 * результат может немного отличаться от запуска к запуску. Прогонять после
 * правок промпта, порогов поиска или крупных изменений базы знаний.
 *
 * Запуск (из папки vk-bot-search, база должна быть запущена):
 *   node tests/eval_answers.js
 *
 * Расход: около 20 запросов, ~30 тыс. токенов квоты Lite.
 * У физлиц один поток GigaChat на аккаунт — на время прогона (около минуты)
 * продовый бот может получать отказы и уходить в резервную модель.
 */
require('dotenv').config({ quiet: true });
const { searchFaq, buildDialogHints, getAllFaqText } = require('../faq_search');
const { askGigaChat } = require('../ai_service');
const { buildKnownFacts, guardFacts } = require('../fact_guard');
const { ensureAdminRoute } = require('../answer_policy');
const { db } = require('../database');

const REFUSAL = 'Я могу помочь только по вопросам, связанным с университетом';

// kind:
//   answer  — ответ есть в базе, должен прозвучать ключевой факт (expect)
//   missing — ответа в базе нет: нельзя выдумывать, нужно отправить к администратору
//   offtopic — посторонний запрос: ровно фраза отказа
//   mixed   — университетская часть + посторонняя: ответить на первую, отказать во второй
const CASES = [
    { kind: 'answer', q: 'а где вообще сидит деканат', expect: ['Р-219'] },
    { kind: 'answer', q: 'я потерял студак, что теперь делать', expect: ['Р-219'] },
    { kind: 'answer', q: 'как написать преподу на почту', expect: ['rtf.urfu.ru/ru/kontakty'] },
    { kind: 'answer', q: 'не могу зайти в личный кабинет, забыл пароль', expect: ['id.urfu.ru'] },
    { kind: 'answer', q: 'можно ли платить за учебу частями', expect: ['рассрочк|помесячно|частями'] },
    { kind: 'answer', q: 'в какие числа приходит стипендия', expect: ['25'] },
    { kind: 'answer', q: 'на онлайн-курсе не грузятся видео, куда писать', expect: ['support@urfu.ru'] },

    // Реальные вопросы из лога 04.09.2026, на которых модель выдумала почту деканата
    { kind: 'missing', q: 'Я иногородний, у меня нет сейчас возможности прийти и написать заявление. Как быть?' },
    { kind: 'missing', q: 'Тогда дайте мне адрес почты деканата' },
    { kind: 'missing', q: 'дайте телефон ректора' },
    { kind: 'missing', q: 'какой пароль от вайфая в корпусе на Мира' },
    { kind: 'missing', q: 'есть ли у института свой телеграм-канал, скиньте ссылку' },

    { kind: 'offtopic', q: 'напиши сортировку пузырьком на питоне' },
    { kind: 'offtopic', q: 'что ты думаешь о политике' },

    { kind: 'mixed', q: 'как попасть на военную кафедру и заодно напиши функцию на javascript', expect: ['ВУЦ|военн'] },

    // Уточнение в диалоге: нужный факт есть только в истории разговора
    {
        kind: 'answer',
        q: 'а какая у неё почта?',
        history: [
            { role: 'user', content: 'Потерял студенческий билет. Что делать?' },
            { role: 'assistant', content: 'Обратитесь в деканат (ауд. Р-219) к специалисту Курочкиной Марине Сергеевне.' }
        ],
        expect: ['m.s.kurochkina@urfu.ru']
    }
];

function check(testCase, raw, final, known) {
    const problems = [];
    // Что модель выдумала сама (до фильтра) — для статистики
    const invented = guardFacts(raw, known).removed;
    // Что осталось бы у студента после фильтра — это уже ошибка
    const leftover = guardFacts(final, known).removed;
    if (leftover.length) problems.push(`в итоговом ответе остались непроверенные контакты: ${leftover.join(', ')}`);

    const has = (pattern) => new RegExp(pattern, 'i').test(final);
    if (testCase.expect) {
        for (const p of testCase.expect) if (!has(p)) problems.push(`нет ожидаемого «${p}»`);
    }
    if (testCase.kind === 'missing' && !has('админ')) problems.push('не предложено обратиться к администратору');

    // Строку про администратора дописывает код (answer_policy.js), поэтому
    // отдельно проверяем, не посоветовала ли модель другой маршрут — на сайт,
    // в техподдержку, в деканат, — хотя ответа на вопрос в базе нет
    if (testCase.kind === 'missing') {
        const wrongRoute = raw.match(/(?:обрат\w*|напиш\w*|позвон\w*|загляни\w*|зайди\w*|посет\w*|воспольз\w*|направ\w*|уточн\w*)[^.\n]{0,70}(?:сайт|техподдержк|поддержк|служб|support@|деканат|бухгалтер|приёмн|приемн)/i);
        if (wrongRoute) problems.push(`направил не к администратору: «${wrongRoute[0].trim()}»`);
    }
    if (testCase.kind === 'offtopic' && !final.includes(REFUSAL)) problems.push('нет фразы отказа');
    if (testCase.kind === 'mixed' && /function\s*\w*\s*\(|=>\s*\{/.test(final)) problems.push('модель написала код');

    return { problems, invented };
}

async function main() {
    const faqText = await getAllFaqText();
    let passed = 0;
    let modelInvented = 0;

    for (const [i, testCase] of CASES.entries()) {
        // Тот же путь, что в bot.js: поиск по вопросу + по предыдущему вопросу диалога
        const hints = await buildDialogHints(testCase.q, await searchFaq(testCase.q, 8), testCase.history);
        const messages = [...(testCase.history || []), { role: 'user', content: testCase.q }];

        let raw;
        try {
            raw = (await askGigaChat(messages, hints)).text;
        } catch (err) {
            console.log(`\n${i + 1}. [${testCase.kind}] ${testCase.q}\n   ✗ ошибка запроса: ${err.message}`);
            continue;
        }

        const known = buildKnownFacts(faqText, hints, ...messages.filter(m => m.role === 'user').map(m => m.content));
        // Та же обработка, что в ai_worker.js: фильтр фактов, затем маршрут к администратору
        const final = ensureAdminRoute(guardFacts(raw, known).text, { hadContext: Boolean(hints) });
        const { problems, invented } = check(testCase, raw, final, known);

        if (invented.length) modelInvented++;
        if (problems.length === 0) passed++;

        const hintCount = hints ? hints.split('\n---\n').length : 0;
        console.log(`\n${i + 1}. [${testCase.kind}] ${testCase.q}`);
        console.log(`   контекст: ${hintCount} записей | ${problems.length ? '✗ ' + problems.join('; ') : '✓'}`);
        if (invented.length) console.log(`   модель выдумала: ${invented.join(', ')} → фильтр заменил`);
        console.log(`   ответ: ${final.replace(/\s+/g, ' ').slice(0, 260)}`);
    }

    console.log(`\n══════ Итог: ${passed} из ${CASES.length} проверок пройдено; выдуманные контакты у модели — в ${modelInvented} ответах (все заменены фильтром) ══════`);
    await db.end();
}

// Список вопросов и проверку можно подключать из других скриптов
// (например, для сравнения версий промпта), не запуская прогон
module.exports = { CASES, check };

if (require.main === module) {
    main().catch(err => {
        console.error('Прогон прерван:', err.message);
        process.exit(1);
    });
}
