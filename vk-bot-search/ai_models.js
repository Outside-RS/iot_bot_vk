// Каталог моделей GigaChat.
// Вынесен в отдельный модуль без зависимостей от БД, чтобы его могли
// подключать скрипты миграции, не открывая пул соединений приложения.
//
// Во freemium-режиме для физлиц квоты у классов моделей НЕЗАВИСИМЫЕ:
// исчерпание Lite не мешает работать Pro, и так далее.
// Порядок в массиве = порядок эскалации при исчерпании квоты.
// balanceKey — как класс называется в ответе GET /api/v1/balance
// (там у Сбера старые имена без «-2»).
const GIGACHAT_MODELS = [
    { class: 'lite', id: 'GigaChat-2',     balanceKey: 'GigaChat',     quota: 250000000 },
    { class: 'pro',  id: 'GigaChat-2-Pro', balanceKey: 'GigaChat-Pro', quota: 40000000 },
    { class: 'max',  id: 'GigaChat-2-Max', balanceKey: 'GigaChat-Max', quota: 25000000 }
];

module.exports = { GIGACHAT_MODELS };
