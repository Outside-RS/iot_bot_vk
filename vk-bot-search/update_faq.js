// Загрузка базы знаний из файла faq_data.json в таблицу faq.
//
//   node update_faq.js              — дополнить базу
//   node update_faq.js --replace    — заменить базу целиком
//   node update_faq.js --replace --yes   — то же без вопроса
//
// Обычный запуск дополняет базу, а не заменяет: запись с тем же вопросом
// обновляется, остальные остаются на месте. Так же работает кнопка «Импорт»
// в админке. Поэтому загрузка новой базы поверх старой оставляет старые
// вопросы в базе, и бот продолжает отвечать по ним.
//
// Флаг --replace удаляет все записи базы знаний и загружает файл начисто.
// Остальные таблицы не трогает — в отличие от reset_db.js, который сносит всё,
// включая пользователей, обращения и настройки ИИ. Удаление и загрузка идут
// одной транзакцией: если файл окажется битым, старая база останется на месте.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const REPLACE = process.argv.includes('--replace');

// Подтверждение на удаление — как в reset_db.js: в терминале спрашиваем,
// в автоматическом запуске требуем явный флаг
async function confirmReplace() {
    const r = await db.query('SELECT count(*) FROM faq');
    const count = r.rows[0].count;

    console.log('\n⚠️  ЗАМЕНА БАЗЫ ЗНАНИЙ — все записи будут удалены безвозвратно.');
    console.log(`   База: ${process.env.DB_NAME} на ${process.env.DB_HOST}:${process.env.DB_PORT || 5432}`);
    console.log(`   Сейчас в ней вопросов: ${count}`);
    console.log('   Обращения, пользователи и настройки не пострадают.');
    console.log('   Без флага --replace скрипт дополняет базу, ничего не удаляя.\n');

    if (process.argv.includes('--yes')) {
        console.log('   Подтверждено флагом --yes.');
        return true;
    }
    if (!process.stdin.isTTY) {
        console.error('Нет подтверждения: запустите скрипт в терминале или добавьте флаг --yes.');
        return false;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(`Чтобы удалить все ${count} вопросов, введите: удалить `, resolve));
    rl.close();
    return answer.trim().toLowerCase() === 'удалить';
}

const db = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

async function updateFaq() {
    try {
        await db.connect();
        console.log('Синхронизация FAQ...');

        const jsonPath = path.join(__dirname, 'faq_data.json');
        if (!fs.existsSync(jsonPath)) {
            console.error('Файл faq_data.json не найден!');
            return;
        }

        const faqData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        let added = 0;
        let updated = 0;
        let removed = 0;

        if (REPLACE) {
            if (!(await confirmReplace())) {
                console.log('Отменено, база не тронута.');
                return;
            }
            // Транзакция: пока она не завершена, старые записи ещё на месте.
            // Любая ошибка ниже откатит и удаление, и загрузку
            await db.query('BEGIN');
            const r = await db.query('DELETE FROM faq');
            removed = r.rowCount;
            // Нумерация с единицы: иначе новая база начнётся с номера,
            // на котором закончилась старая
            await db.query('ALTER SEQUENCE faq_id_seq RESTART WITH 1');
            console.log(`Удалено записей: ${removed}`);
        }

        for (const item of faqData) {
            // Совпадение ищем по тексту вопроса: своих идентификаторов у записей
            // в файле нет, а вопрос — единственное, что их различает
            const checkRes = await db.query('SELECT id, answer, keywords FROM faq WHERE question = $1', [item.question]);

            // Ключевые слова в файле бывают и массивом, и строкой через запятую.
            // Приводим к одному виду, иначе сравнение ниже посчитает изменением
            // даже одинаковый по смыслу список
            const newKeywords = (Array.isArray(item.keywords) ? item.keywords : (item.keywords || '').split(','))
                .map(k => k.trim())
                .filter(k => k.length > 0)
                .join(', ');

            if (checkRes.rows.length > 0) {
                // Запись уже есть: трогаем её, только если ответ или ключевые
                // слова изменились — иначе в журнале будет шум на всю базу
                const row = checkRes.rows[0];

                if (row.answer !== item.answer || row.keywords !== newKeywords) {
                    await db.query(
                        'UPDATE faq SET answer = $1, category = $2, keywords = $3 WHERE id = $4',
                        [item.answer, item.category, newKeywords, row.id]
                    );
                    console.log(`Обновлено: "${item.question}"`);
                    updated++;
                }
            } else {
                // Добавляем новый
                await db.query(
                    'INSERT INTO faq (category, question, answer, keywords) VALUES ($1, $2, $3, $4)',
                    [item.category, item.question, item.answer, newKeywords]
                );
                console.log(`Добавлено: "${item.question}"`);
                added++;
            }
        }

        if (REPLACE) await db.query('COMMIT');

        console.log(REPLACE
            ? `Готово! База заменена: удалено ${removed}, загружено ${added}`
            : `Готово! Добавлено: ${added}, Обновлено: ${updated}`);

    } catch (err) {
        if (REPLACE) await db.query('ROLLBACK').catch(() => {});
        console.error('Ошибка загрузки базы знаний:', err.message);
        if (REPLACE) console.error('Изменения откачены, старая база знаний на месте.');
        process.exitCode = 1;
    } finally {
        await db.end();
    }
}

updateFaq();