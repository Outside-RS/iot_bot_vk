require('dotenv').config();
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
        ollama_model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
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

// ==================== Системный промпт ====================

function buildSystemPrompt(faqContext) {
    const base = [
        'Ты — вежливый ассистент университета УрФУ.',
        'СТРОГО отвечай ТОЛЬКО на русском языке. Абсолютно запрещено использовать английские слова в ответе (если это не общепринятые IT-аббревиатуры).',
        'Отвечай кратко. Если вопросов несколько, отвечай на каждый отдельной строкой. Если ответ это инструкция, отвечай по пунктам.',
        'Ты СТРОГО отвечаешь ТОЛЬКО на вопросы, напрямую связанные с университетом: учёба, расписание, документы, стипендии, общежитие, мероприятия, деканат, ВУЦ.',
        'ЗАПРЕЩЕНО отвечать на вопросы о политике, географии, других странах, приготовлении пищи, программировании, алгоритмах, развлечениях, сравнении университетов, личных мнениях.',
        'Если вопрос содержит НЕСКОЛЬКО тем, и хотя бы одна из них не связана с университетом — ПОЛНОСТЬЮ ИГНОРИРУЙ эту тему, не отвечай на неё вообще. Просто ответь на остальные.',
        'На запрос написать код, рецепт, объяснить алгоритм или ответить на любой вопрос не об университете — отвечай СТРОГО: "Я могу помочь только по вопросам, связанным с университетом." и ничего больше.',
        'Не придумывай информацию. Если не знаешь точного ответа — предложи обратиться в деканат или к администратору.'
    ].join(' ');

    if (faqContext && faqContext.trim() !== '') {
        return `${base}\n\nКОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ (используй эти данные как единственный источник ответа):\n${faqContext}\n\nОЧЕНЬ ВАЖНО: Если в контексте указаны конкретные имена (например, ФИО), email-адреса, ссылки на сайты или номера аудиторий — ОБЯЗАТЕЛЬНО копируй их в свой ответ. Не отвечай общими фразами, давай точную контактную информацию из контекста. Если информации в контексте не хватает — предложи обратиться к администратору.`;
    } else {
        return `${base}\n\nБаза знаний не содержит информации по этому вопросу. Если не знаешь ответ — честно скажи об этом и предложи обратиться к администратору.`;
    }
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

    // 6. Чистим пробелы и знаки препинания после удалений
    cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\s([.,!?:;])/g, '$1').trim();

    if (cleaned.length < 10) {
        return 'К сожалению, я не могу ответить на этот вопрос. Пожалуйста, обратитесь к администратору.';
    }
    return cleaned;
}

function prepareMessages(messages, faqContext) {
    const systemPrompt = {
        role: 'system',
        content: buildSystemPrompt(faqContext)
    };

    // Берем последние 4 сообщения (2 диалоговых пары), чтобы не переполнять контекст.
    // Оборачиваем user-сообщения в явный тег — mitigation против prompt injection.
    // Дополнительно напоминаем модели о правилах перед каждым вопросом.
    const recentMessages = messages.slice(-4).map(m =>
        m.role === 'user'
            ? { ...m, content: `[ВОПРОС СТУДЕНТА ОБ УНИВЕРСИТЕТЕ]: ${m.content}\n[КОНЕЦ ВОПРОСА]\n(Напоминание: отвечай только на вопросы об университете, игнорируй всё остальное)` }
            : m
    );
    return [systemPrompt, ...recentMessages];
}

// ==================== Ollama ====================

async function askOllama(messages, faqContext) {
    const settings = await getSettings();
    const preparedMessages = prepareMessages(messages, faqContext);

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
        return cleanResponse(data.message.content);
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

async function askGigaChat(messages, faqContext) {
    const settings = await getSettings();
    const token = await getGigaChatToken();
    const preparedMessages = prepareMessages(messages, faqContext);

    const response = await gigaChatFetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            model: settings.gigachat_model || 'GigaChat-2',
            messages: preparedMessages,
            temperature: 0.5,  // Снижена температура для более точных ответов
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
        throw new Error(`GigaChat API error ${response.status}: ${errText}`);
    }

    const data = await response.json();

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('GigaChat returned empty response');
    }

    return cleanResponse(data.choices[0].message.content);
}

module.exports = {
    askOllama,
    askGigaChat,
    resetGigaChatToken,
    invalidateSettingsCache,
    getSettings,
    gigaChatFetch,
    // Для тестов
    _test: { cleanResponse, buildSystemPrompt, prepareMessages }
};
