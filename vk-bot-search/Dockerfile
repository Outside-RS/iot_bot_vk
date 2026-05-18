FROM node:18-alpine

# Создаем директорию приложения
WORKDIR /app

# Копируем файлы зависимостей
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем исходный код
COPY . .

# Открываем порт для админ-панели
EXPOSE 3000

# Запускаем приложение
CMD ["node", "index.js"]
