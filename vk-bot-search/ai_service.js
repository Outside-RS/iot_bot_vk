require('dotenv').config();

// Сертификат Сбера (GigaChat) не в стандартном CA-хранилище Node.js
// Без этой строки fetch к gigachat.devices.sberbank.ru упадёт с UNABLE_TO_VERIFY_LEAF_SIGNATURE
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function buildSystemPrompt(faqContext) {
    const base = [
        'Ты — вежливый ассистент университета.',
        'СТРОГО отвечай ТОЛЬКО на русском языке. Запрещено использовать любые другие языки.',
        'Отвечай кратко — 2-3 предложения максимум.',
        'Ты отвечаешь ТОЛЬКО на вопросы, связанные с университетом: учёба, расписание, документы, стипендии, общежитие, мероприятия, стажировки, студенческая жизнь.',
        'На любые вопросы НЕ связанные с университетом (программирование, еда, погода, игры, личные просьбы и т.д.) — вежливо откажи и скажи: "Я могу помочь только по вопросам, связанным с университетом."',
        'Никогда не пиши код, не давай рецепты, не отвечай на общие вопросы.'
    ].join(' ');

    if (faqContext && faqContext.trim() !== '') {
        return `${base} Используй предоставленный контекст базы знаний для ответа: ${faqContext}. Если вопрос выходит за рамки контекста — предложи обратиться к администратору.`;
    } else {
        return `${base} У тебя нет информации из базы знаний. Если не знаешь ответ — честно скажи, что не владеешь этой информацией, и предложи обратиться к администратору.`;
    }
}

// Пост-фильтр: убирает вставки на иностранных языках (китайский, вьетнамский и т.д.)
function cleanResponse(text) {
    // Убираем символы CJK (китайский/японский/корейский), вьетнамские диакритики и прочие нелатинские/некириллические блоки
    let cleaned = text.replace(/[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\u1E00-\u1EFF\u0100-\u024F]+/g, '').trim();
    // Убираем двойные пробелы после удаления
    cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\s([.,!?])/g, '$1');

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

    // Берем последние 6 сообщений, чтобы не переполнять контекст
    const recentMessages = messages.slice(-6);
    return [systemPrompt, ...recentMessages];
}

async function askOllama(messages, faqContext) {
    const preparedMessages = prepareMessages(messages, faqContext);

    const url = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
    const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

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
                stream: false
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

async function getGigaChatToken() {
    const authKey = process.env.GIGACHAT_AUTH_KEY;
    const scope = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';

    if (!authKey) {
        throw new Error('GigaChat API key is missing (GIGACHAT_AUTH_KEY)');
    }

    // Если токен ещё живой — возвращаем кэшированный
    if (gigaChatToken && Date.now() < gigaChatTokenExpiresAt) {
        return gigaChatToken;
    }

    console.log('[AI] GigaChat: запрашиваем новый токен...');

    const crypto = require('crypto');
    const rquid = crypto.randomUUID();

    const response = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
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
    // Токен живёт 30 минут, обновляем за минуту до истечения
    gigaChatTokenExpiresAt = data.expires_at || (Date.now() + 29 * 60 * 1000);

    console.log('[AI] GigaChat: токен получен');
    return gigaChatToken;
}

async function askGigaChat(messages, faqContext) {
    const token = await getGigaChatToken();
    const preparedMessages = prepareMessages(messages, faqContext);

    const response = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            model: 'GigaChat-2',
            messages: preparedMessages,
            temperature: 0.7,
            max_tokens: 300,
            n: 1,
            stream: false,
            repetition_penalty: 1
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        // Если токен протух — сбрасываем кэш
        if (response.status === 401) {
            gigaChatToken = null;
            gigaChatTokenExpiresAt = 0;
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
    // Для тестов
    _test: { cleanResponse, buildSystemPrompt, prepareMessages }
};
