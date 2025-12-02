CREATE TABLE IF NOT EXISTS faq (
    id SERIAL PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('russian', question || ' ' || answer)) STORED
);
CREATE INDEX IF NOT EXISTS faq_search_idx ON faq USING GIN (search_vector);

-- Example data
INSERT INTO faq (question, answer) VALUES
('Как сбросить пароль?', 'Чтобы сбросить пароль, перейдите в настройки и нажмите "Забыли пароль".'),
('Какие способы оплаты?', 'Мы принимаем карты Visa, MasterCard и МИР.'),
('Где находится офис?', 'Наш офис находится по адресу: г. Москва, ул. Пушкина, д. 10.');

-- 1. Таблица кодов операторов
CREATE TABLE IF NOT EXISTS operator_codes (
    code TEXT PRIMARY KEY,
    tutor_name TEXT,
    allowed_groups TEXT[]
);

-- Вставка тестовой записи
INSERT INTO operator_codes (code, tutor_name, allowed_groups)
VALUES ('TUTOR-IOT', 'Куратор Анна', '{"РИ-140944", "РИ-140945"}')
ON CONFLICT (code) DO NOTHING;

-- 2. Таблица пользователей
CREATE TABLE IF NOT EXISTS users (
    vk_id BIGINT PRIMARY KEY,
    role TEXT, -- 'student', 'operator'
    full_name TEXT,
    group_number TEXT, -- для студентов
    linked_code TEXT, -- для операторов
    state TEXT, -- шаг диалога
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 1. Добавляем поле active_ticket_id в таблицу users (если его нет)
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_ticket_id INTEGER;

-- 2. Создаем таблицу тикетов
CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    student_vk_id BIGINT NOT NULL,
    operator_vk_id BIGINT,         -- NULL, пока оператор не взял тикет
    question TEXT NOT NULL,
    status TEXT DEFAULT 'open',    -- 'open', 'active', 'closed'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. (Опционально) Индекс для ускорения поиска открытых тикетов
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status);