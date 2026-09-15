// Логирование приложения.
//
// Весь код пишет логи через console.* с тегом подсистемы в начале строки:
//   console.info('[SEARCH] Запрос ...')     → уровень INFO,  тег SEARCH
//   console.warn('[DB] Медленный запрос')    → уровень WARN,  тег DB
//   console.debug('[FSM] ...')               → уровень DEBUG, тег FSM
// install() перехватывает console и раскладывает записи в три места:
//   1. обычный вывод процесса (терминал / docker logs);
//   2. кольцевой буфер в памяти — страница «Логи» в админке;
//   3. файл logs/app-ГГГГ-ММ-ДД.log — переживает перезапуск, хранится N дней.
//
// Настройки из .env (все необязательные):
//   LOG_LEVEL           debug | info | warn | error   (по умолчанию debug)
//   LOG_TIMEZONE        часовой пояс для времени в логах (по умолчанию Asia/Yekaterinburg)
//   LOG_RETENTION_DAYS  сколько дней хранить файлы (по умолчанию 14)
//   LOG_DIR             папка для файлов (по умолчанию logs рядом с проектом)

const fs = require('fs');
const path = require('path');
const util = require('util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const FILE_RE = /^app-(\d{4}-\d{2}-\d{2})\.log$/;

/**
 * Форматирует время в заданном часовом поясе. Через Intl, а не через системный
 * пояс: в Docker-контейнере системное время — UTC, а в логах нужно местное.
 */
function makeClock(timeZone) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    return (date) => {
        const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
        const day = `${p.year}-${p.month}-${p.day}`;
        return { day, stamp: `${day} ${p.hour}:${p.minute}:${p.second}` };
    };
}

/**
 * Один аргумент console.* → строка. Объект ошибки раньше превращался
 * в «{}»: JSON.stringify не видит message и stack. Теперь — текст и код.
 */
function errorText(err) {
    // У AggregateError (pg при неудачном подключении и по IPv6, и по IPv4)
    // собственное сообщение пустое — причина во вложенных ошибках
    let msg = err.message;
    if (!msg && Array.isArray(err.errors) && err.errors.length > 0) {
        msg = [...new Set(err.errors.map(e => e.message))].join('; ');
    }
    return err.code ? `${msg || err.name} [${err.code}]` : (msg || err.name);
}

function formatArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return errorText(arg);
    if (arg === null || arg === undefined || typeof arg !== 'object') return String(arg);
    try {
        return JSON.stringify(arg);
    } catch {
        return util.inspect(arg, { depth: 1, breakLength: Infinity });
    }
}

const stripAnsi = (s) => s.replace(/\[\d+m/g, '');

/** «[SEARCH] Запрос…» → { tag: 'SEARCH', msg: 'Запрос…' }. Без тега — APP */
function splitTag(text) {
    const m = text.match(/^\s*\[([A-Za-z_]+)\]\s*/);
    return m ? { tag: m[1].toUpperCase(), msg: text.slice(m[0].length) } : { tag: 'APP', msg: text };
}

function createLogger(options = {}) {
    const {
        dir = null,
        level = 'debug',
        timeZone = 'Asia/Yekaterinburg',
        retentionDays = 14,
        bufferSize = 1000,
        echo = null,           // { log, error } — куда дублировать вывод
        now = () => new Date() // подменяется в тестах
    } = options;

    const minLevel = LEVELS[level] || LEVELS.debug;
    const clock = makeClock(timeZone);
    const buffer = [];
    let nextId = 1;

    let stream = null;
    let streamDay = null;
    let fileBroken = false;

    function reportFileProblem(err) {
        if (fileBroken) return;
        fileBroken = true;
        if (echo) echo.error(`[LOG] Запись логов в файл отключена: ${err.message}`);
    }

    function cleanupOldFiles(today) {
        const cutoff = clock(new Date(now().getTime() - retentionDays * 86400000)).day;
        let files = [];
        try { files = fs.readdirSync(dir); } catch { return; }
        for (const name of files) {
            const m = name.match(FILE_RE);
            if (m && m[1] < cutoff && m[1] !== today) {
                try { fs.unlinkSync(path.join(dir, name)); } catch { /* файл занят — удалим в другой раз */ }
            }
        }
    }

    function fileFor(day) {
        if (!dir || fileBroken) return null;
        if (stream && streamDay === day) return stream;

        // Наступил новый день (или первый запуск) — новый файл и уборка старых
        if (stream) stream.end();
        try {
            fs.mkdirSync(dir, { recursive: true });
            stream = fs.createWriteStream(path.join(dir, `app-${day}.log`), { flags: 'a' });
            stream.on('error', reportFileProblem);
            streamDay = day;
            cleanupOldFiles(day);
        } catch (err) {
            reportFileProblem(err);
            stream = null;
        }
        return stream;
    }

    function write(levelName, args) {
        if (LEVELS[levelName] < minLevel) return null;

        const { day, stamp } = clock(now());
        const text = stripAnsi(args.map(formatArg).join(' '));
        const { tag, msg } = splitTag(text);
        const errorWithStack = args.find(a => a instanceof Error && a.stack);

        const entry = { id: nextId++, ts: stamp, level: levelName.toUpperCase(), tag, msg };
        if (levelName === 'error' && errorWithStack) entry.stack = errorWithStack.stack;

        buffer.push(entry);
        if (buffer.length > bufferSize) buffer.shift();

        const line = `[${stamp}] ${entry.level.padEnd(5)} [${tag}] ${msg}`;
        const out = fileFor(day);
        if (out) out.write(line + (entry.stack ? `\n    ${entry.stack.split('\n').slice(1).join('\n    ')}` : '') + '\n');

        if (echo) (LEVELS[levelName] >= LEVELS.warn ? echo.error : echo.log)(line);
        return entry;
    }

    return {
        debug: (...a) => write('debug', a),
        info: (...a) => write('info', a),
        warn: (...a) => write('warn', a),
        error: (...a) => write('error', a),

        /** Записи из буфера с id больше sinceId — для догрузки на странице логов */
        entries(sinceId = 0) {
            return buffer.filter(e => e.id > sinceId);
        },

        /** Даты, за которые есть файлы, — новые сверху */
        files() {
            if (!dir) return [];
            try {
                return fs.readdirSync(dir).map(n => (n.match(FILE_RE) || [])[1]).filter(Boolean).sort().reverse();
            } catch {
                return [];
            }
        },

        /** Путь к файлу за дату или null. Дата строго ГГГГ-ММ-ДД — защита от ../ в пути */
        filePath(day) {
            if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
            const p = path.join(dir, `app-${day}.log`);
            return fs.existsSync(p) ? p : null;
        },

        /** Дописывает буфер на диск и закрывает файл */
        close() {
            return new Promise((resolve) => {
                if (!stream) return resolve();
                stream.end(resolve);
                stream = null;
            });
        }
    };
}

let installed = null;

/** Перехватывает console.* во всём процессе. Вызывается один раз при старте. */
function install() {
    if (installed) return installed;

    const original = {
        log: console.log.bind(console),
        error: console.error.bind(console)
    };

    installed = createLogger({
        dir: process.env.LOG_DIR || path.join(__dirname, 'logs'),
        level: (process.env.LOG_LEVEL || 'debug').toLowerCase(),
        timeZone: process.env.LOG_TIMEZONE || 'Asia/Yekaterinburg',
        retentionDays: Number(process.env.LOG_RETENTION_DAYS) || 14,
        echo: original
    });

    console.debug = (...a) => installed.debug(...a);
    console.log = (...a) => installed.info(...a);
    console.info = (...a) => installed.info(...a);
    console.warn = (...a) => installed.warn(...a);
    console.error = (...a) => installed.error(...a);

    return installed;
}

module.exports = { install, createLogger, errorText, getLogger: () => installed, _test: { formatArg, splitTag, makeClock } };
