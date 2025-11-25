CREATE TABLE IF NOT EXISTS faq (
    id SERIAL PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    search_vector TSVECTOR
);

-- Create an index for faster full-text search
CREATE INDEX IF NOT EXISTS faq_search_idx ON faq USING GIN (search_vector);

-- Function to automatically update the search_vector column
CREATE OR REPLACE FUNCTION faq_tsvector_trigger() RETURNS trigger AS $$
BEGIN
  new.search_vector := to_tsvector('russian', new.question || ' ' || new.answer);
  RETURN new;
END
$$ LANGUAGE plpgsql;

-- Trigger to update search_vector on insert or update
DROP TRIGGER IF EXISTS tsvectorupdate ON faq;
CREATE TRIGGER tsvectorupdate BEFORE INSERT OR UPDATE
ON faq FOR EACH ROW EXECUTE PROCEDURE faq_tsvector_trigger();

-- Example data
INSERT INTO faq (question, answer) VALUES
('Как сбросить пароль?', 'Чтобы сбросить пароль, перейдите в настройки и нажмите "Забыли пароль".'),
('Какие способы оплаты?', 'Мы принимаем карты Visa, MasterCard и МИР.'),
('Где находится офис?', 'Наш офис находится по адресу: г. Москва, ул. Пушкина, д. 10.');
