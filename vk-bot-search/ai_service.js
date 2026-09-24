require('dotenv').config({ quiet: true });
const https = require('https');
const { db } = require('./database');

// Сбер использует сертификат не из стандартного CA-хранилища Node.js.
// Агент с отключённой проверкой применяется только к запросам GigaChat,
// чтобы не затрагивать VK API и Ollama.
const gigaChatAgent = new https.Agent({ rejectUnauthorized: false });

function gigaChatFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request(
            {
                hostname: u.hostname,
                port: u.port || 443,
                path: u.pathname + u.search,
                method: options.method || 'GET',
                headers: options.headers || {},
                agent: gigaChatAgent,
            },
            (res) => {
                let raw = '';
                res.on('data', chunk => raw += chunk);
                res.on('end', () => resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    text: () => Promise.resolve(raw),
                    json: () => Promise.resolve(JSON.parse(raw)),
                }));
            }
        );
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ==================== Получение настроек из БД ====================
// Кэш настроек (обновляется каждые 30 секунд чтобы не дёргать БД на каждый запрос)
let settingsCache = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 30000; // 30 секунд

async function getSettings() {
    if (settingsCache && Date.now() - settingsCacheTime < SETTINGS_CACHE_TTL) {
        return settingsCache;
    }

    try {
        const res = await db.query('SELECT * FROM app_settings WHERE id = TRUE');
        if (res.rows.length > 0) {
            settingsCache = res.rows[0];
            settingsCacheTime = Date.now();
            return settingsCache;
        }
    } catch (err) {
        console.error('[AI] Ошибка чтения app_settings:', err.message);
    }

    // Fallback на .env если таблица ещё не создана
    return {
        ollama_url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
        ollama_model: process.env.OLLAMA_MODEL || 'qwen3:8b',
        gigachat_key: process.env.GIGACHAT_AUTH_KEY || null,
        gigachat_scope: process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS',
        gigachat_model: 'GigaChat-2'
    };
}

/** Сбросить кэш настроек (вызывается при сохранении через UI) */
function invalidateSettingsCache() {
    settingsCache = null;
    settingsCacheTime = 0;
}

// ==================== Каталог моделей GigaChat ====================
// Сам каталог и квоты — в ai_models.js. Расход считаем отдельно по каждому
// классу, а при исчерпании квоты поднимаемся к следующему.
const { GIGACHAT_MODELS } = require('./ai_models');

function findModel(modelId) {
    return GIGACHAT_MODELS.find(m => m.id === modelId) || null;
}

/**
 * Порядок опроса моделей: сначала выбранная в панели, затем остальные
 * по иерархии вверх. Классы с исчерпанной квотой пропускаются.
 */
async function getGigaChatChain() {
    const settings = await getSettings();
    const preferredId = settings.gigachat_model || GIGACHAT_MODELS[0].id;

    let exhausted = new Set();
    try {
        const res = await db.query('SELECT model_class FROM ai_usage WHERE exhausted = TRUE');
        exhausted = new Set(res.rows.map(r => r.model_class));
    } catch (err) {
        // Таблицы может не быть до миграции — тогда работаем без учёта квот
        console.error('[AI] Не удалось прочитать ai_usage:', err.message);
    }

    const preferred = findModel(preferredId);
    const ordered = preferred
        ? [preferred, ...GIGACHAT_MODELS.filter(m => m.id !== preferred.id)]
        : [...GIGACHAT_MODELS];

    const available = ordered.filter(m => !exhausted.has(m.class));

    // Модель, выбранной в панели, может не быть в каталоге (например новая) —
    // тогда всё равно пробуем её первой, как указал администратор.
    if (!preferred && preferredId) {
        available.unshift({ class: 'custom', id: preferredId, quota: null });
    }
    return available;
}

/** Записывает расход токенов и гасит класс, когда квота выбрана */
async function recordUsage(modelId, tokens) {
    const model = findModel(modelId);
    if (!model || !tokens) return;

    try {
        const res = await db.query(
            `UPDATE ai_usage
                SET tokens_used = tokens_used + $2,
                    exhausted = (tokens_used + $2) >= quota,
                    updated_at = NOW()
              WHERE model_class = $1
          RETURNING tokens_used, quota, exhausted`,
            [model.class, tokens]
        );
        if (res.rows.length === 0) {
            // Строки нет — значит класс моделей добавили в ai_models.js, но не
            // прогнали migrate_update.js. Расход по нему не считается, и квота
            // кончится незаметно, поэтому говорим об этом вслух
            console.warn(`[AI] Класс моделей «${model.class}» не заведён в ai_usage — расход не учитывается. Запустите migrate_update.js`);
            return;
        }

        const { tokens_used, quota, exhausted } = res.rows[0];
        const percent = Math.round((Number(tokens_used) / Number(quota)) * 100);
        if (exhausted) {
            console.error(`[AI] Квота модели ${modelId} исчерпана (${tokens_used}/${quota}). Переходим к следующей.`);
        } else if (percent >= 80) {
            console.error(`[AI] Внимание: у модели ${modelId} израсходовано ${percent}% квоты (${tokens_used}/${quota}).`);
        }
    } catch (err) {
        console.error('[AI] Не удалось записать расход токенов:', err.message);
    }
}

/** Помечает класс модели как исчерпанный (когда об этом сообщил сам API) */
async function markExhausted(modelId) {
    const model = findModel(modelId);
    if (!model) return;
    try {
        await db.query('UPDATE ai_usage SET exhausted = TRUE, updated_at = NOW() WHERE model_class = $1', [model.class]);
        console.error(`[AI] Класс ${model.class} (${modelId}) помечен как исчерпанный по ответу API.`);
    } catch (err) {
        console.error('[AI] Не удалось пометить класс исчерпанным:', err.message);
    }
}

/**
 * Отличает исчерпание квоты от обычного сбоя.
 * Точную сигнатуру Сбер в документации не описывает, поэтому смотрим и на код,
 * и на текст ошибки. При появлении реального ответа список стоит уточнить.
 */
function isQuotaError(status, text) {
    if (status === 402) return true;
    const t = (text || '').toLowerCase();
    return /quota|лимит|исчерпан|недостаточно|balance|баланс/.test(t);
}

// ==================== Системный промпт ====================

// Промпт разбит на разделы: GigaChat заметно лучше следует структурированным
// инструкциям, чем сплошному абзацу. Главное изменение против прежней версии —
// раздел «Откуда брать факты». Прежний промпт требовал «ОБЯЗАТЕЛЬНО копируй
// контакты из контекста, не отвечай общими фразами», и вместе с нерелевантным
// контекстом это подталкивало модель выдать контакт любой ценой — так появился
// несуществующий адрес dekanat-rtf@urfu.ru.
// Без эмодзи из подписи кнопки: иначе модель копирует его и лепит эмодзи всюду
const ADMIN_BUTTON = '«Передать администратору»';

function buildSystemPrompt(faqContext, provider = 'gigachat') {
    const base = `Ты — ИИ-ассистент поддержки студентов Института радиоэлектроники и информационных технологий (ИРИТ-РТФ) УрФУ. Ты отвечаешь студентам в сообществе ВКонтакте.

# Тематика
Ты отвечаешь на вопросы, связанные с учёбой и университетской жизнью: расписание, сессия, пересдачи, дисциплины, майноры, стипендии, оплата обучения, документы, общежитие, деканат, военный учебный центр, практика, выпускная работа, студенческие мероприятия.
Вопрос о дисциплине («есть ли пересдача по программированию?») — организационный, на него отвечай.
ЗАПРЕЩЕНО отвечать на технические запросы (написать код, объяснить алгоритм, решить задачу по программированию), а также на вопросы о политике и просьбы высказать личное мнение. На такой запрос ответь ровно одной фразой: «Я могу помочь только по вопросам, связанным с университетом.»
Если в сообщении несколько тем и часть из них посторонняя — ответь только на университетскую часть.

# Откуда брать факты
Единственный источник фактов — раздел «КОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ» ниже. Сведения об УрФУ из собственной памяти не используй: они могут быть устаревшими или неверными.
Адреса почты, телефоны, ссылки, номера аудиторий, ФИО, даты и суммы называй только если они дословно есть в контексте или в твоих предыдущих ответах этого диалога. Никогда не составляй адрес почты или ссылку по аналогии с другими.
Если нужного факта нет — прямо скажи, что в базе знаний этого нет, и предложи нажать кнопку ${ADMIN_BUTTON}: администраторы ответят точно. Не утверждай, что такой информации не существует или её нельзя найти, — говори только, что её нет в базе знаний.

# Куда направлять студента
Для вопроса, ответа на который нет в контексте, единственный маршрут — кнопка ${ADMIN_BUTTON}. Не отправляй на сайт университета, в деканат, в техподдержку или по другим контактам.
Направить в конкретную службу можно, только если в контексте прямо сказано, что именно этот вопрос решают там. Запись контекста про похожую, но другую ситуацию (например, про восстановление студенческого билета, когда спрашивают про пропуск в общежитие) — не основание отправлять туда студента.

# Формат ответа
СТРОГО отвечай ТОЛЬКО на русском языке, без английских слов (кроме названий сайтов и систем).
Отвечай кратко: 2–5 предложений. Инструкцию оформляй нумерованным списком, каждый пункт с новой строки.
Не используй эмодзи.`;

    const context = (faqContext && faqContext.trim() !== '')
        ? `# КОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ
Записи проверены администраторами. Не все они обязательно относятся к вопросу — используй только подходящие.

${faqContext}`
        : `# КОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ
База знаний не содержит информации по этому вопросу.
Не отвечай по памяти. Если ответ есть в предыдущих сообщениях этого диалога — используй их. Иначе коротко скажи, что точного ответа в базе нет, и предложи нажать ${ADMIN_BUTTON} — администратор ответит лично.
Исключение — вопрос, который НЕ касается правил, процедур и порядков университета (например, как вежливо составить письмо преподавателю): на него можно дать общий совет без контактов, дат и сумм. Как подать заявление, куда отправить документы, можно ли что-то сделать дистанционно — это вопросы о порядках университета: по памяти на них не отвечай.`;

    // /no_think отключает режим рассуждений у qwen3 (локальная модель).
    // GigaChat этой директивы не знает, ему она не нужна.
    const prefix = provider === 'ollama' ? '/no_think\n' : '';
    return `${prefix}${base}\n\n${context}`;
}

// Пост-фильтр: убирает артефакты иностранных языков и стоп-токены моделей из ответа
function cleanResponse(text) {
    // 0. Удаляем стоп-токены Llama/Qwen/Mistral которые иногда «протекают» в ответ
    let cleaned = text
        .replace(/<\|im_start\|>.*?$/s, '')  // <|im_start|> и всё после него
        .replace(/<\|im_end\|>/g, '')
        .replace(/<\|end\|>/g, '')
        .replace(/<\|eot_id\|>/g, '')
        .replace(/\[INST\].*?\[\/INST\]/gs, '')
        .replace(/<s>|<\/s>/g, '')
        .trim();

    // 1. CJK, полноширокие символы, расширенная латиница, вьетнамские диакритики
    cleaned = cleaned.replace(
        /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF\u1E00-\u1EFF\u0100-\u024F]+/g, ''
    ).trim();

    // 2. Латиница внутри кириллического слова: "Тюstinой" → "Тюой"
    cleaned = cleaned.replace(/(?<=[\u0400-\u04FF])[A-Za-z]+(?=[\u0400-\u04FF])/g, '');

    // 3. ALL-CAPS латиница сразу после кириллицы: "поSEMESTER" → "по"
    cleaned = cleaned.replace(/(?<=[\u0400-\u04FF])[A-Z]{2,}\b/g, '');

    // 4. CamelCase после кириллицы: "иProcedure" → "и"
    cleaned = cleaned.replace(/(?<=[\u0400-\u04FF])[A-Z][a-z]+\w*/g, '');

    // 5. Латиница перед кириллицей без пробела: "SEMESTERе" → "е"
    cleaned = cleaned.replace(/[A-Za-z]+(?=[\u0400-\u04FF])/g, '');

    // 5.5. Разметка, которую ВКонтакте не отображает — студент увидел бы её
    // как есть. GigaChat вставляет <br/>, **жирный**, *курсив*, цитаты «>» и заголовки «#».
    cleaned = cleaned
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '');

    // 6. Чистим пробелы и знаки препинания после удалений.
    // Только пробелы и табуляцию: раньше здесь было \s, и переводы строк тоже
    // схлопывались — нумерованные списки и абзацы приходили студенту одной строкой.
    cleaned = cleaned
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([.,!?:;])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (cleaned.length < 10) {
        return 'К сожалению, я не могу ответить на этот вопрос. Пожалуйста, обратитесь к администратору.';
    }
    return cleaned;
}

function prepareMessages(messages, faqContext, provider = 'gigachat') {
    const systemPrompt = {
        role: 'system',
        content: buildSystemPrompt(faqContext, provider)
    };

    // Берем последние 10 сообщений (5 диалоговых пар), чтобы не переполнять контекст.
    // Лимит синхронизирован с обрезкой истории в bot.js (enqueueAiTask).
    const recent = messages.slice(-10);

    // После обрезки история может начаться с ответа ассистента без вопроса к нему —
    // такой «осиротевший» ответ только сбивает модель
    while (recent.length > 0 && recent[0].role === 'assistant') recent.shift();

    const lastUserIndex = recent.map(m => m.role).lastIndexOf('user');

    const recentMessages = recent.map((m, i) => {
        // В API уходят только role и content: служебное поле model из истории не нужно
        if (m.role !== 'user') return { role: m.role, content: m.content };

        // Каждый вопрос студента оборачиваем в явный тег — защита от prompt injection.
        // Напоминание о правилах добавляем только к последнему вопросу: повторять
        // его в каждом сообщении истории — лишние токены без пользы.
        const reminder = i === lastUserIndex
            ? '\n(Напоминание: отвечай только по университетским вопросам и только фактами из контекста.)'
            : '';
        return {
            role: 'user',
            content: `[ВОПРОС СТУДЕНТА ОБ УНИВЕРСИТЕТЕ]: ${m.content}\n[КОНЕЦ ВОПРОСА]${reminder}`
        };
    });
    return [systemPrompt, ...recentMessages];
}

// ==================== Ollama ====================

async function askOllama(messages, faqContext) {
    const settings = await getSettings();
    const preparedMessages = prepareMessages(messages, faqContext, 'ollama');

    const url = settings.ollama_url + '/api/chat';
    const model = settings.ollama_model;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 секунд

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                messages: preparedMessages,
                stream: false,
                options: {
                    temperature: 0.2,    // справочный бот: точность важнее разнообразия формулировок
                    num_predict: 2500,   // Увеличен чтобы ответ не обрывался
                    stop: ['<|im_start|>', '<|im_end|>', '<|end|>', '[INST]', '</s>'] // Стоп-токены
                }
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Ollama HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (!data.message || !data.message.content) {
            throw new Error('Ollama returned empty response');
        }
        // Единый формат ответа для всех провайдеров: воркеру нужны и модель, и расход
        return {
            text: cleanResponse(data.message.content),
            provider: 'Ollama',
            model: model,
            tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
        };
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('[AI] Ollama недоступна, вызов fallback:', error.message);
        throw error;
    }
}

// ==================== GigaChat ====================
let gigaChatToken = null;
let gigaChatTokenExpiresAt = 0;
let gigaChatCachedKey = null; // Запоминаем ключ, с которым получен токен

/** Сброс кэша токена GigaChat (вызывается при смене API-ключа через UI) */
function resetGigaChatToken() {
    gigaChatToken = null;
    gigaChatTokenExpiresAt = 0;
    gigaChatCachedKey = null;
    console.log('[AI] GigaChat: кэш токена сброшен');
}

async function getGigaChatToken() {
    const settings = await getSettings();
    const authKey = settings.gigachat_key;
    const scope = settings.gigachat_scope || 'GIGACHAT_API_PERS';

    if (!authKey) {
        throw new Error('GigaChat API key is missing (настройте в панели управления)');
    }

    // Если ключ изменился — сбрасываем старый токен
    if (gigaChatCachedKey && gigaChatCachedKey !== authKey) {
        resetGigaChatToken();
    }

    // Если токен ещё живой — возвращаем кэшированный
    if (gigaChatToken && Date.now() < gigaChatTokenExpiresAt) {
        return gigaChatToken;
    }

    console.log('[AI] GigaChat: запрашиваем новый токен...');

    const crypto = require('crypto');
    const rquid = crypto.randomUUID();

    const response = await gigaChatFetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Authorization': `Basic ${authKey}`,
            'RqUID': rquid
        },
        body: `scope=${scope}`
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`GigaChat OAuth error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    gigaChatToken = data.access_token;
    gigaChatCachedKey = authKey;
    // Токен живёт 30 минут, обновляем за минуту до истечения
    gigaChatTokenExpiresAt = data.expires_at || (Date.now() + 29 * 60 * 1000);

    console.log('[AI] GigaChat: токен получен');
    return gigaChatToken;
}

// ==================== Остаток токенов у Сбера ====================

/**
 * Сверяет учёт токенов с балансом аккаунта у Сбера.
 *
 * Зачем: прод и локальная копия тратят ОДНУ квоту аккаунта, а каждая считает
 * только свой расход. Точная цифра есть только у Сбера — метод
 * GET /api/v1/balance отдаёт остаток по каждому классу моделей
 * (проверено: работает и во freemium-режиме).
 *
 * Вызывается по кнопке на дашборде, а не по таймеру: баланс нужен человеку,
 * когда он на него смотрит. Между сверками бот ведёт приблизительный учёт
 * по полю usage из ответов модели.
 */
async function syncBalanceFromGigaChat() {
    const request = async () => {
        const token = await getGigaChatToken();
        return gigaChatFetch('https://gigachat.devices.sberbank.ru/api/v1/balance', {
            headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
        });
    };

    let response = await request();
    if (response.status === 401) {
        // Токен успел протухнуть — получаем новый и пробуем ещё раз
        resetGigaChatToken();
        response = await request();
    }
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Сбер вернул ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const remainingByKey = new Map((data.balance || []).map(b => [b.usage, Number(b.value)]));

    for (const model of GIGACHAT_MODELS) {
        if (!remainingByKey.has(model.balanceKey)) continue;
        const remaining = remainingByKey.get(model.balanceKey);

        // Израсходовано = квота − остаток. Если остаток больше известной квоты
        // (например, куплен пакет), поднимаем квоту до остатка.
        // Класс снова считается доступным, как только остаток > 0 —
        // так бот сам «оживает» после ежегодного обновления квоты.
        await db.query(
            `UPDATE ai_usage
                SET quota = GREATEST(quota, $2),
                    tokens_used = GREATEST(quota, $2) - $2,
                    exhausted = ($2 <= 0),
                    updated_at = NOW()
              WHERE model_class = $1`,
            [model.class, remaining]
        );
    }

    console.log('[AI] Баланс GigaChat сверен со Сбером: ' +
        GIGACHAT_MODELS.filter(m => remainingByKey.has(m.balanceKey))
            .map(m => `${m.id} — осталось ${remainingByKey.get(m.balanceKey)}`).join(', '));
}

async function askGigaChat(messages, faqContext, modelId = null) {
    const settings = await getSettings();
    const token = await getGigaChatToken();
    const preparedMessages = prepareMessages(messages, faqContext);
    const model = modelId || settings.gigachat_model || GIGACHAT_MODELS[0].id;

    const response = await gigaChatFetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            model: model,
            messages: preparedMessages,
            temperature: 0.2,  // справочный бот: при 0.5 модель охотнее «достраивала» контакты
            max_tokens: 1000,   // Увеличен лимит чтобы ответ точно не обрывался
            n: 1,
            stream: false,
            repetition_penalty: 1.1
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        // Если токен протух — сбрасываем кэш
        if (response.status === 401) {
            resetGigaChatToken();
        }
        // Исчерпание квоты — не сбой: гасим класс модели, чтобы воркер
        // сразу перешёл к следующему, и помечаем ошибку особым флагом.
        if (isQuotaError(response.status, errText)) {
            await markExhausted(model);
            const quotaErr = new Error(`GigaChat quota exhausted for ${model}: ${errText}`);
            quotaErr.quotaExhausted = true;
            throw quotaErr;
        }
        throw new Error(`GigaChat API error ${response.status}: ${errText}`);
    }

    const data = await response.json();

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('GigaChat returned empty response');
    }

    const tokens = data.usage ? (data.usage.total_tokens || 0) : 0;
    await recordUsage(model, tokens);

    return {
        text: cleanResponse(data.choices[0].message.content),
        provider: 'GigaChat',
        model: model,
        tokens: tokens
    };
}

// ======================= РАЗБОР ДИАЛОГА ДЛЯ БАЗЫ ЗНАНИЙ =======================

const FAQ_DRAFT_PROMPT = `Ты помогаешь вести базу знаний бота поддержки студентов института.

На вход — переписка студента с администратором. Нужно превратить её в одну запись базы знаний:
коротко сформулировать вопрос и дать самодостаточный ответ.

Правила:
- Вопрос: одна строка от лица студента, без имён и приветствий, максимум 15 слов.
- Ответ: только то, что администратор действительно сообщил. Ничего не добавляй от себя:
  ни телефонов, ни адресов, ни ссылок, которых не было в переписке. Пиши по существу,
  в 1-4 предложениях, безлично («нужно подойти», а не «подойди»).
- Не переноси в ответ разовые обстоятельства: фамилию студента, номер его группы,
  конкретные даты вида «завтра», номер обращения.
- Ключевые слова: 3-7 фраз через запятую, по которым студенты будут это искать.
- Категория: выбери одну ИЗ СПИСКА, если подходит; если ни одна не подходит — придумай короткую.

Ответ верни СТРОГО в формате JSON, без пояснений и без markdown:
{"category": "...", "question": "...", "answer": "...", "keywords": "..."}`;

/** Достаёт JSON из ответа модели: она иногда оборачивает его в текст или ``` */
function parseDraftJson(text) {
    const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
        throw new Error('модель вернула ответ не в формате JSON');
    }
    const draft = JSON.parse(cleaned.slice(start, end + 1));
    const value = (v) => String(v === undefined || v === null ? '' : v).trim();
    const result = {
        category: value(draft.category) || 'Без категории',
        question: value(draft.question),
        answer: value(draft.answer),
        keywords: value(draft.keywords)
    };
    if (!result.question || !result.answer) {
        throw new Error('в ответе модели нет вопроса или ответа');
    }
    return result;
}

/**
 * Готовит запись базы знаний по переписке администратора со студентом.
 * Возвращает { category, question, answer, keywords } — черновик,
 * который администратор подтверждает в боте. Сам ничего не сохраняет.
 */
async function draftFaqFromDialog(dialogText, categories = []) {
    const token = await getGigaChatToken();
    const chain = await getGigaChatChain();
    if (chain.length === 0) throw new Error('все квоты GigaChat исчерпаны');
    const model = chain[0].id;

    const categoryList = categories.length ? `Существующие категории: ${categories.join(', ')}.` : '';

    const response = await gigaChatFetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: `${FAQ_DRAFT_PROMPT}\n${categoryList}` },
                { role: 'user', content: dialogText }
            ],
            temperature: 0.1,   // пересказ переписки, а не сочинение
            max_tokens: 800,
            n: 1,
            stream: false
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        if (response.status === 401) resetGigaChatToken();
        if (isQuotaError(response.status, errText)) {
            await markExhausted(model);
            const quotaErr = new Error(`GigaChat quota exhausted for ${model}: ${errText}`);
            quotaErr.quotaExhausted = true;
            throw quotaErr;
        }
        throw new Error(`GigaChat API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('GigaChat вернул пустой ответ');
    }
    await recordUsage(model, data.usage ? (data.usage.total_tokens || 0) : 0);

    return parseDraftJson(data.choices[0].message.content);
}

module.exports = {
    askOllama,
    askGigaChat,
    syncBalanceFromGigaChat,
    GIGACHAT_MODELS,
    getGigaChatChain,
    resetGigaChatToken,
    invalidateSettingsCache,
    getSettings,
    gigaChatFetch,
    draftFaqFromDialog,
    // Для тестов
    _test: { cleanResponse, buildSystemPrompt, prepareMessages, parseDraftJson, FAQ_DRAFT_PROMPT }
};
