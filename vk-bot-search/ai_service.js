require('dotenv').config();

function buildSystemPrompt(faqContext) {
    const base = 'Ты — вежливый ассистент университета. СТРОГО отвечай ТОЛЬКО на русском языке. Запрещено использовать любые другие языки (английский, китайский и т.д.). Отвечай кратко — 2-3 предложения максимум.';

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

async function askGigaChat(messages, faqContext) {
    // Заглушка: GigaChat ещё не подключен
    throw new Error('GigaChat API key is missing');
}

module.exports = {
    askOllama,
    askGigaChat
};
