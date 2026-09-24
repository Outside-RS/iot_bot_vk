// Проверка внешнего доступа к админке.
//
// Зачем. Панель выходит в интернет длинной цепочкой: браузер → сервер с frps →
// туннель frpc → Caddy → бот. Порваться может любое звено, и почти все обрывы
// бесшумные: бот продолжает отвечать студентам, копии делаются, в журнале
// тишина — просто тьюторы не могут открыть панель и не понимают почему.
//
// Модуль раз в несколько минут ходит на публичный адрес снаружи, ровно как
// тьютор из дома, и запоминает результат. Проверяется вся цепочка целиком:
// частичные проверки (жив ли контейнер, поднят ли туннель) врут — туннель
// бывает поднят, а панель недоступна.
//
// Переключить панель на локальный адрес самостоятельно модуль не может и не
// пытается: это значило бы перенастроить Caddy и пересоздать контейнеры, то
// есть дать боту власть над Docker. Вместо переключения — постоянная
// доступность по обоим адресам (см. docker-compose.yml) и внятное сообщение,
// когда внешний перестал работать.
const https = require('https');
const { db } = require('./database');

const PUBLIC_IP = (process.env.PUBLIC_IP || '').trim();

// Как часто проверять и сколько ждать ответа
const CHECK_INTERVAL_MS = Number(process.env.EXTERNAL_CHECK_MINUTES || 10) * 60 * 1000;
const TIMEOUT_MS = 15000;
// Сколько неудач подряд до объявления «недоступно». Одиночный сбой сети или
// секундный обрыв туннеля не повод будить администраторов ночью
const FAILS_BEFORE_ALARM = 2;

let timer = null;
let fails = 0;
// Подменяется в тестах: проверять логику состояний, не выходя в сеть
let probeFn = probe;
let state = {
    configured: Boolean(PUBLIC_IP),
    ok: null,              // null — ещё не проверяли
    checkedAt: null,
    changedAt: null,
    reason: null,          // текст последней ошибки
    certExpires: null      // до какого числа действует сертификат
};

/** Одна проверка: запрос к публичному адресу снаружи */
function probe() {
    return new Promise(resolve => {
        const req = https.request({
            host: PUBLIC_IP,
            port: 443,
            path: '/login',
            method: 'HEAD',
            timeout: TIMEOUT_MS,
            // Сертификат здесь не проверяем: задача — понять, доходит ли запрос.
            // Про срок действия скажем отдельно, он читается из самого ответа
            rejectUnauthorized: false,
            servername: PUBLIC_IP
        }, res => {
            let certExpires = null;
            try {
                const cert = res.socket.getPeerCertificate();
                if (cert && cert.valid_to) certExpires = new Date(cert.valid_to).toISOString();
            } catch (_) { /* сертификата нет — не беда */ }
            res.resume();
            resolve({ ok: res.statusCode > 0, code: res.statusCode, certExpires });
        });

        req.on('timeout', () => { req.destroy(new Error(`нет ответа за ${TIMEOUT_MS / 1000} с`)); });
        req.on('error', err => resolve({ ok: false, error: err.message }));
        req.end();
    });
}

/** Администраторы, которым уходят уведомления бота */
async function operatorsToNotify() {
    const res = await db.query(
        "SELECT vk_id, vk_group_id FROM users WHERE role = 'operator' AND notify_tickets = TRUE"
    );
    return res.rows;
}

/** Сообщение администраторам о смене состояния */
async function tellOperators(text) {
    let sent = 0;
    try {
        for (const op of await operatorsToNotify()) {
            const bot = op.vk_group_id && global.bots && global.bots[String(op.vk_group_id)];
            if (!bot) continue;
            try {
                await bot.api.messages.send({ peer_id: Number(op.vk_id), random_id: 0, message: text });
                sent++;
            } catch (err) {
                console.debug(`[EXTERNAL] Не доставлено ${op.vk_id}: ${err.message}`);
            }
        }
    } catch (err) {
        console.error('[EXTERNAL] Не удалось оповестить администраторов:', err.message);
    }
    return sent;
}

async function runCheck() {
    const result = await probeFn();
    const now = new Date().toISOString();
    state.checkedAt = now;
    if (result.certExpires) state.certExpires = result.certExpires;

    if (result.ok) {
        fails = 0;
        if (state.ok !== true) {
            const wasDown = state.ok === false;
            state.ok = true;
            state.changedAt = now;
            state.reason = null;
            console.info(`[EXTERNAL] Внешний доступ работает: https://${PUBLIC_IP} отвечает (код ${result.code})`);
            if (wasDown) {
                await tellOperators(`✅ Панель снова открывается снаружи: https://${PUBLIC_IP}`);
            }
        }
        return;
    }

    fails++;
    state.reason = result.error || `код ${result.code}`;
    if (state.ok === false) return;                 // уже объявляли, молчим
    if (fails < FAILS_BEFORE_ALARM) {
        console.warn(`[EXTERNAL] Внешний адрес не ответил (${state.reason}), попытка ${fails} из ${FAILS_BEFORE_ALARM}`);
        return;
    }

    state.ok = false;
    state.changedAt = now;
    console.error(`[EXTERNAL] Внешний доступ пропал: https://${PUBLIC_IP} — ${state.reason}`);
    const sent = await tellOperators(
        `⚠️ Панель перестала открываться по адресу https://${PUBLIC_IP}.\n\n` +
        'Бот работает как обычно, студенты ничего не заметили. Недоступна только панель снаружи.\n\n' +
        'Что делать: на рабочем компьютере панель открыта по адресу http://localhost:3000, ' +
        'а в сети университета — по адресу этого компьютера. Если нужно вернуть внешний доступ, ' +
        'см. DEPLOY.md, разделы 8 и 13.'
    );
    console.info(`[EXTERNAL] Оповещено администраторов: ${sent}`);
}

function startExternalCheck() {
    if (timer) return;
    if (!PUBLIC_IP) {
        console.info('[EXTERNAL] PUBLIC_IP не задан — проверка внешнего доступа выключена');
        return;
    }
    // Первая проверка не сразу: туннелю и Caddy нужно время подняться
    setTimeout(() => { runCheck().catch(err => console.error('[EXTERNAL] Ошибка проверки:', err.message)); }, 2 * 60 * 1000).unref();
    timer = setInterval(() => { runCheck().catch(err => console.error('[EXTERNAL] Ошибка проверки:', err.message)); }, CHECK_INTERVAL_MS);
    timer.unref();
    console.info(`[EXTERNAL] Проверка внешнего доступа включена: https://${PUBLIC_IP}, раз в ${CHECK_INTERVAL_MS / 60000} мин`);
}

function stopExternalCheck() {
    if (timer) { clearInterval(timer); timer = null; }
}

/** Состояние для карточки на главной странице панели */
function getExternalState() {
    return { ...state };
}

module.exports = {
    startExternalCheck, stopExternalCheck, getExternalState,
    _test: {
        probe,
        runCheck,
        setProbe: (fn) => { probeFn = fn || probe; },
        reset: () => { fails = 0; state = { configured: true, ok: null, checkedAt: null, changedAt: null, reason: null, certExpires: null }; }
    }
};
