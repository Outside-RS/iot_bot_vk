# Как дорабатывать бота

Документ для того, кто продолжит разработку. Ниже — как поднять рабочее
окружение и пошаговые разборы типовых задач.

---

## Рабочее окружение

Нужны Node.js 22, Docker и редактор. База удобнее в Docker:

```bash
docker run -d --name vk-bot-db -p 5433:5432 -e POSTGRES_PASSWORD=пароль postgres:15-alpine
```

```bash
cd vk-bot-search
npm install
cp .env.example .env     # заполнить DB_*, ADMIN_PASS, SESSION_SECRET
node reset_db.js         # схема + загрузка faq_data.json
node index.js
```

Панель — `http://localhost:3000`.

**Обязательно укажите в `.env` своё тестовое сообщество:**

```
ALLOWED_GROUP_IDS=234189923
```

Без этого бот подключится ко всем сообществам из базы. Если в локальной базе
лежат рабочие сообщества, ваш бот начнёт перехватывать сообщения студентов —
ВКонтакте отдаёт сообщение только одному получателю.

По той же причине не запускайте локально контейнер `frpc`: он зарегистрируется
на рабочем сервере под тем же именем и перехватит туннель панели.

### Полезные переменные при отладке

```
LOG_LEVEL=debug          # видно поиск по базе знаний с оценками совпадений
DB_SLOW_QUERY_MS=100     # ловить медленные запросы
```

---

## Тесты

```bash
DB_NAME=vk_bot_test npm test
```

Тесты пишут в ту базу, которая указана в `.env`, поэтому заводите отдельную.
Часть тестов работает без базы (разбор текста, промпт), часть — с базой
(очередь, курсы, права).

Запустить только нужные:

```bash
node --test --test-name-pattern="курс" tests/test_all.js
```

---

## Задача 1. Добавить кнопку в боте

Допустим, нужна кнопка «📞 Контакты деканата», которая шлёт готовый текст.

**Шаг 1.** Добавьте кнопку в меню — `mainMenu()` в `bot.js`:

```js
keyboard: Keyboard.builder()
    .textButton({ label: '✉️ Задать вопрос', color: Keyboard.PRIMARY_COLOR })
    .row()
    .textButton({ label: '📞 Контакты деканата', payload: { command: 'contacts' }, color: Keyboard.SECONDARY_COLOR })
```

**Шаг 2.** Обработайте команду — в `handleMessage()`, в блоке `if (messagePayload)`:

```js
if (messagePayload.command === 'contacts') {
    console.info(`[BOT] ${senderId} запросил контакты деканата`);
    return context.send('Деканат ИРИТ-РТФ: ул. Мира, 32, аудитория Р-219.');
}
```

**Что важно:**

- в payload кладите только команду и числа. Лимит ВКонтакте — 255 символов,
  длинный текст делает кнопку недопустимой и сообщение не отправляется вообще;
- если кнопка доступна не всем — проверьте роль: `if (await getRole(senderId) !== 'operator') return ...`;
- inline-клавиатура вмещает 6 строк, обычная — больше, но не увлекайтесь;
- подпись кнопки — до 40 символов.

---

## Задача 2. Добавить шаг диалога

Например, спрашивать у студента курс отдельным шагом.

**Шаг 1.** Переведите пользователя в новое состояние там, откуда начинается шаг:

```js
await db.query("UPDATE users SET state = 'ask_course' WHERE vk_id = $1", [senderId]);
await context.send('На каком вы курсе?');
```

**Шаг 2.** Обработайте состояние в `processState()`:

```js
case 'ask_course':
    if (text === '🔙 Назад') { /* вернуть на предыдущий шаг */ }
    if (!/^[1-4]$/.test(text)) return context.send('Введите цифру от 1 до 4.');
    await db.query("UPDATE users SET study_years = $1, state = 'main_menu' WHERE vk_id = $2", [text, senderId]);
    await context.send('Записал.');
    return mainMenu(context, user);
```

Состояние — это строка в `users.state`. Добавьте описание нового шага в
[bot-flow.md](bot-flow.md), иначе через месяц никто не вспомнит, что это.

**Правило: ветка обязана ответить при любом вводе.** Человек напишет не то, что
вы ждёте, — это не исключение, а норма. Если ветка на чужой ввод не отвечает
ничего, он остаётся без кнопок и без подсказки и выйти уже не может.

Плохо — тупик, когда пришло что-то третье:

```js
case 'ask_course':
    if (text === '1') { /* ... */ }
    else if (text === '2') { /* ... */ }
    break;   // на «первый» бот промолчит
```

Хорошо — повторить вопрос вместе с кнопками:

```js
case 'ask_course':
    if (text === '1') { /* ... */ }
    else if (text === '2') { /* ... */ }
    else await context.send({ message: 'Выберите курс кнопкой:', keyboard: courseKeyboard() });
    break;
```

Подписи кнопок должны совпадать с тем, что ветка разбирает, буква в букву.
Кнопка `✏️` при проверке `text === '✏️ Изменить текст'` не сработает — такое
уже случалось. Если одна и та же клавиатура выдаётся из двух мест, вынесите её
в функцию, как `ticketManageKeyboard()`.

Страховка на случай недосмотра есть (`recoverToMenu` в `bot.js` вернёт человека
в меню и напишет предупреждение в журнал), но она нужна для того, чего никто не
предусмотрел, а не вместо ветки: человека она выкидывает из диалога.

---

## Задача 3. Добавить колонку в базу

Колонку нужно добавить **в двух местах**, иначе она появится только на новых
установках или только на старых.

**Шаг 1.** `reset_db.js` — в описание таблицы:

```js
CREATE TABLE users (
    ...
    -- зачем нужна колонка: одна строка объяснения
    phone TEXT,
    ...
);
```

**Шаг 2.** `migrate_update.js` — идемпотентно:

```js
await c.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT');
```

Если у колонки должно быть значение по умолчанию только для новых строк —
ставьте его отдельной командой, иначе всем существующим строкам проставится
одно и то же:

```js
await c.query('ALTER TABLE faq ADD COLUMN IF NOT EXISTS created_at TIMESTAMP');
await c.query('ALTER TABLE faq ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP');
```

Если без значения в новой колонке старые строки перестанут работать, их нужно
заполнить — но ровно один раз, при первом добавлении. Проверить, была ли
колонка, можно до `ALTER TABLE`:

```js
const had = await c.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'tickets' AND column_name = 'vk_group_id'"
);
await c.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS vk_group_id BIGINT');
if (had.rowCount === 0) {
    const filled = await c.query(`UPDATE tickets t SET vk_group_id = u.vk_group_id
                                    FROM users u
                                   WHERE u.vk_id = t.student_vk_id AND t.vk_group_id IS NULL`);
    console.log(`Обращениям проставлено сообщество: ${filled.rowCount}.`);
}
```

Так реально сделано для сообщества обращения: без него старые обращения не
попали бы ни в одну очередь. Печатать, скольким строкам проставили, стоит
всегда — при обновлении рабочей базы это единственный способ понять, что
миграция сделала то, что задумано.

**Шаг 3.** Проверьте оба пути:

```bash
node reset_db.js --yes        # чистая установка
node migrate_update.js        # обновление существующей базы

В Docker на рабочем компьютере то же самое делается разовым контейнером, до
запуска нового кода: `docker compose run --rm bot node migrate_update.js`.
```

**Шаг 4.** Допишите колонку в [database.md](database.md).

---

## Задача 4. Добавить страницу в панель

Например, раздел «Статистика».

**Шаг 1.** Маршрут в `routes/admin.js`:

```js
router.get('/stats', requireAuth, noCache, async (req, res) => {
    try {
        const byStatus = await db.query('SELECT status, count(*) FROM tickets GROUP BY status');
        res.render('stats', { rows: byStatus.rows });
    } catch (e) {
        console.error('[Admin] Ошибка статистики:', e.message);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});
```

**Шаг 2.** Шаблон `views/stats.ejs` — на общем каркасе:

```ejs
<%- include('partials/layout_start', { title: 'Статистика', active: '/stats' }) %>

<div class="page-head">
    <h1 class="page-title">Статистика</h1>
</div>

<div class="table-wrap">
    <table>
        <thead><tr><th>Состояние</th><th>Сколько</th></tr></thead>
        <tbody>
            <% rows.forEach(function (r) { %>
                <tr><td><%= r.status %></td><td><%= r.count %></td></tr>
            <% }); %>
        </tbody>
    </table>
</div>

<%- include('partials/layout_end') %>
```

**Шаг 3.** Пункт меню — в `views/partials/layout_start.ejs`, массив `menu`:

```js
{ href: '/stats', icon: '📈', label: 'Статистика' }
```

**Что важно:**

- значения выводите через `<%= %>` — оно экранирует. `<%- %>` только для
  подключения общих кусков;
- у форм, которые что-то меняют, обязательно скрытое поле
  `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`, иначе запрос
  отклонится;
- списки, которые могут вырасти, выводите постранично — помощники `paging()`
  и `queryWithoutPage()` уже есть в `routes/admin.js`, а разметка — в
  `partials/pager.ejs`;
- готовые классы оформления смотрите в `public/css/admin.css`: `.card`,
  `.btn`, `.icon-btn`, `.table-wrap`, `.badge`, `.toolbar`, `.kpi`. Своих
  цветов и размеров не вводите — берите переменные из начала файла;
- обработчики событий — в `public/js/ui.js` или в блоке `<script>` внизу
  страницы. `onclick=` в разметке запрещён политикой безопасности.

---

## Задача 5. Написать тест

Тесты лежат в одном файле `tests/test_all.js`, сгруппированы по разделам.

Без базы:

```js
describe('courses — разбор названия сообщества', () => {
    const { parseCommunityName } = require('../courses');

    it('«Второй курс» превращается в курс 2', () => {
        assert.equal(parseCommunityName('Второй курс ИОТ, УрФУ').course, 2);
    });
});
```

С базой и диалогом бота:

```js
describe('bot — новая кнопка', () => {
    const { handleMessage } = require('../bot')._test;
    const STUDENT = 99999901;
    const sent = [];
    const vk = { api: { messages: { send: async () => 1 } } };
    const ctx = (over = {}) => ({
        senderId: STUDENT, text: null, attachments: [], messagePayload: null,
        send: async (m) => { sent.push(m); return 1; }, ...over
    });

    before(async () => {
        await db.query("INSERT INTO users (vk_id, role, state) VALUES ($1, 'student', 'main_menu')", [STUDENT]);
    });
    after(async () => {
        await db.query('DELETE FROM users WHERE vk_id = $1', [STUDENT]);
    });

    it('Кнопка присылает контакты', async () => {
        sent.length = 0;
        await handleMessage(ctx({ messagePayload: { command: 'contacts' } }), vk, 123);
        assert.ok(String(sent[0]).includes('Р-219'), String(sent[0]));
    });
});
```

Правила: тестовые пользователи с номерами из диапазона 999999xx, за собой
прибирать в `after`, в комментарии писать, какую поломку тест стережёт.

---

## Задача 6. Поменять поведение ИИ

| Что менять | Где |
|---|---|
| Промпт: тематика, правила, формат ответа | `buildSystemPrompt()` в `ai_service.js` |
| Порог прямого ответа из базы знаний | `DIRECT_MIN_SCORE` в `faq_search.js` |
| Порог подсказки для модели | `HINT_MIN_SCORE` там же |
| Сколько записей уходит в контекст | `MAX_HINTS` там же |
| Глубина истории диалога | `prepareMessages()` в `ai_service.js` и обрезка в `enqueueAiTask()` в `bot.js` — менять синхронно |
| Порядок перебора моделей и квоты | `ai_models.js` и `getGigaChatChain()` |

После правки промпта прогоните контрольные вопросы:

```bash
node tests/eval_answers.js
```

Скрипт задаёт живой модели 16 вопросов с известными ответами и показывает, где
она ошиблась. Расходует токены GigaChat, поэтому запускается вручную.

Меняя пороги, помните, за что они отвечают: слишком низкий порог подсказок — и
в модель уходит шум, после чего она начинает придумывать ответ, подгоняя его
под нерелевантные записи.

---

## Отладка

**Смотреть, что происходит:** панель, раздел «Логи», фильтр по подсистеме.
Или прямо в консоли, где запущен `node index.js`.

**Понять, почему бот не ответил из базы знаний:** поставьте `LOG_LEVEL=debug` —
в журнале появятся строки `[SEARCH]` с оценками совпадений и разбивкой на
лексическую и триграммную части.

**Посмотреть, что в базе:**

```bash
docker exec -it vk-bot-db psql -U postgres
```

**Проверить очередь ИИ:**

```sql
SELECT id, vk_id, status, attempts, created_at FROM ai_queue ORDER BY id DESC LIMIT 10;
```

**Бот не подключается к сообществу:** проверьте `is_active` в `vk_groups`, токен
и `ALLOWED_GROUP_IDS` в `.env`. В журнале при старте видно, какие сообщества
подключились, а какие пропущены и почему.

---

## Чего не делать

- **Не подставлять значения в текст SQL-запроса.** Только параметры `$1`, `$2`.
  Иначе вопрос студента с кавычкой сломает запрос, а в худшем случае даст
  доступ к базе.
- **Не выводить в панели данные без экранирования.** Текст студента попадает в
  логи и в обращения; `<%- %>` или `innerHTML` для него — это готовый XSS.
- **Не класть длинный текст в payload кнопки.** 255 символов, дальше ВКонтакте
  отклоняет сообщение целиком.
- **Не хранить состояние диалога в памяти процесса.** Только в `users.state`:
  иначе перезапуск бота обрывает разговоры.
- **Не печатать секреты в журнал** — ни ключ GigaChat, ни токены сообществ.
- **Не запускать `docker compose down -v` на рабочем компьютере** — это удалит
  базу, сертификат и ключ резервных копий.
- **Не запускать `reset_db.js` на рабочей базе** — он удаляет все таблицы.
