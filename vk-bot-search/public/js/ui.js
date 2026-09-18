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

    // Боковое меню на телефоне: открывается кнопкой, закрывается затемнением
    const sidebar = document.getElementById('sidebar');
    const scrim = document.getElementById('scrim');
    const burger = document.getElementById('burger');
    const closeMenu = () => {
        sidebar && sidebar.classList.remove('open');
        scrim && scrim.classList.remove('open');
    };
    if (burger && sidebar && scrim) {
        burger.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            scrim.classList.toggle('open');
        });
        scrim.addEventListener('click', closeMenu);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
    }
});

/** Короткое сообщение в углу экрана вместо alert() */
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return alert(message);
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}
