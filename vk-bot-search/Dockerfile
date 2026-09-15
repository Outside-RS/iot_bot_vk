# Node 22 — актуальная LTS-версия (поддержка до весны 2027).
# Прежний node:18 снят с поддержки в апреле 2025 и больше не получает исправлений безопасности.
FROM node:22-alpine

WORKDIR /app

# Сначала только файлы зависимостей: при правке кода этот слой не пересобирается
COPY package*.json ./

# npm ci ставит ровно те версии, что записаны в package-lock.json (сборка
# повторяема), --omit=dev — без пакетов для разработки
RUN npm ci --omit=dev

# Код. Секреты (.env), локальные node_modules, логи и туннель сюда не попадают —
# см. .dockerignore. Пароли контейнер получает при запуске через env_file в docker-compose.
# Файлы принадлежат пользователю node: админка перезаписывает faq_data.json при экспорте
COPY --chown=node:node . .

# Папка логов (в docker-compose поверх неё монтируется том)
RUN mkdir -p /app/logs && chown node:node /app/logs

# Без прав root: если в приложении найдут уязвимость, у атакующего не будет root в контейнере
USER node

EXPOSE 3000

CMD ["node", "index.js"]
