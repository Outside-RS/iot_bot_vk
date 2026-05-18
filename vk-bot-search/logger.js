const fs = require('fs');
const path = require('path');

const originalLog = console.log;
const originalError = console.error;

global.appLogs = [];
const logFilePath = path.join(__dirname, 'app.log');

function stripAnsi(text) {
    return typeof text === 'string' ? text.replace(/\u001b\[\d+m/g, '') : text;
}

function formatLog(level, args) {
    const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const msg = Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    return `[${time}] ${level}: ${stripAnsi(msg)}`;
}

function addLog(level, args) {
    const logStr = formatLog(level, args);
    
    // Сохраняем в памяти для Админ-панели (последние 500 строк)
    global.appLogs.push(logStr);
    if (global.appLogs.length > 500) {
        global.appLogs.shift(); // удаляем старые
    }
}

console.log = function(...args) {
    addLog('INFO', args);
    originalLog.apply(console, args);
};

console.error = function(...args) {
    addLog('ERROR', args);
    originalError.apply(console, args);
};
