require('dotenv').config();

function buildSystemPrompt(faqContext) {
    if (faqContext && faqContext.trim() !== '') {
        return `Ты — вежливый ассистент университета. Отвечай кратко на русском языке. Используй предоставленный контекст базы знаний: ${faqContext}. Если не можешь помочь или вопрос выходит за рамки контекста — предложи позвать администратора.`;
    } else {
        return `Ты — вежливый ассистент университета. Отвечай кратко на русском языке. У тебя нет контекста из базы знаний. Если не можешь помочь — предложи позвать администратора.`;
    }
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
    const model = process.env.OLLAMA_MODEL || 'llama3';

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
        return data.message.content;
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
