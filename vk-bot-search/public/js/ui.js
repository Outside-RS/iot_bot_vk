// Общие обработчики админки.
// Вынесены из HTML-атрибутов (onclick/onsubmit), потому что CSP запрещает
// инлайновые обработчики: script-src-attr 'none'. Это же правило блокирует
// внедрённые атрибуты вроде onerror=... при попытке XSS.
document.addEventListener('DOMContentLoaded', () => {
    // Формы с подтверждением: <form data-confirm="Точно удалить?">
    document.querySelectorAll('form[data-confirm]').forEach(form => {
        form.addEventListener('submit', event => {
            if (!confirm(form.dataset.confirm)) event.preventDefault();
        });
    });

    // Поля, отправляющие свою форму при изменении: <select data-autosubmit>
    document.querySelectorAll('[data-autosubmit]').forEach(field => {
        field.addEventListener('change', () => field.form && field.form.submit());
    });
});
