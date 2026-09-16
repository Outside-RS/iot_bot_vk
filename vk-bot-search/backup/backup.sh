#!/bin/sh
# Ночная резервная копия базы.
#
# Что делает раз в сутки:
#   1. снимает дамп базы и сжимает его в /backups (папка backups рядом с проектом);
#   2. удаляет копии старше BACKUP_KEEP_DAYS дней;
#   3. если задан BACKUP_SSH_HOST — отправляет копию на сервер по SSH.
#
# Копия на этом же компьютере спасает от ошибок и порчи базы, копия на сервере —
# от смерти диска. Ключ для отправки создаётся сам при первом запуске и лежит
# в отдельном томе: в образ и в репозиторий он не попадает.
set -eu

BACKUP_DIR=/backups
KEY=/keys/id_ed25519
KNOWN_HOSTS=/keys/known_hosts
STATE=/keys/last-backup-date

AT="${BACKUP_TIME:-03:00}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
SSH_HOST="${BACKUP_SSH_HOST:-}"
SSH_USER="${BACKUP_SSH_USER:-botbackup}"
SSH_PORT="${BACKUP_SSH_PORT:-22}"

# Записи идут в поток ошибок: так имя файла, которое возвращает make_dump
# через обычный вывод, не смешивается с текстом журнала
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }

ensure_key() {
    [ -f "$KEY" ] && return 0
    mkdir -p /keys && chmod 700 /keys
    ssh-keygen -t ed25519 -N '' -C "vkbot-backup" -f "$KEY" >/dev/null
    log "Создан ключ для отправки копий на сервер."
}

show_key() {
    log "Открытая часть ключа. Эта строка целиком добавляется на сервер"
    log "в файл /home/$SSH_USER/.ssh/authorized_keys (см. инструкцию по установке):"
    echo "restrict,command=\"/usr/local/bin/receive-backup\" $(cat "$KEY.pub")"
}

# Дамп базы. При ошибке недоделанный файл удаляется, чтобы не выдать его за копию.
make_dump() {
    file="$BACKUP_DIR/vkbot-$(date '+%Y-%m-%d_%H%M').sql.gz"
    mkdir -p "$BACKUP_DIR"
    if ! PGPASSWORD="$DB_PASSWORD" pg_dump -h "${DB_HOST:-db}" -p "${DB_PORT:-5432}" \
            -U "${DB_USER:-postgres}" -d "${DB_NAME:-postgres}" 2>/tmp/dump.err | gzip > "$file"; then
        log "ОШИБКА: не удалось снять дамп базы: $(tr '\n' ' ' < /tmp/dump.err)"
        rm -f "$file"
        return 1
    fi
    # Проверяем, что архив целый и не пустой: битую копию лучше заметить сразу
    if ! gzip -t "$file" 2>/dev/null || [ ! -s "$file" ]; then
        log "ОШИБКА: копия получилась повреждённой, удаляю: $file"
        rm -f "$file"
        return 1
    fi
    log "Копия готова: $(basename "$file"), $(du -h "$file" | cut -f1)"
    echo "$file"
}

# Состояние для админки: карточка «Резервная копия» на главной читает этот файл
write_status() {
    cat > "$BACKUP_DIR/status.json" <<EOF
{"time":"$(date '+%Y-%m-%d %H:%M')","ok":$1,"file":"$2","size":"$3","sent":"$4"}
EOF
}

send_dump() {
    file="$1"
    if ssh -i "$KEY" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
           -o UserKnownHostsFile="$KNOWN_HOSTS" -o ConnectTimeout=20 \
           "$SSH_USER@$SSH_HOST" < "$file"; then
        log "Копия отправлена на сервер $SSH_HOST."
    else
        # Локальная копия при этом остаётся; следующей ночью попробуем снова
        log "ОШИБКА: не удалось отправить копию на сервер $SSH_HOST."
        return 1
    fi
}

cleanup_old() {
    removed=$(find "$BACKUP_DIR" -type f -name 'vkbot-*.sql.gz' -mtime "+$KEEP_DAYS" -print -delete | wc -l)
    [ "$removed" -gt 0 ] && log "Удалено старых копий (старше $KEEP_DAYS дн.): $removed"
    return 0
}

run_once() {
    if ! file=$(make_dump); then
        write_status false "" "" "no"
        return 1
    fi

    sent=off
    if [ -z "$SSH_HOST" ]; then
        log "Отправка на сервер выключена (BACKUP_SSH_HOST не задан)."
    elif send_dump "$file"; then
        sent=yes
    else
        sent=no
    fi

    write_status true "$(basename "$file")" "$(du -h "$file" | cut -f1)" "$sent"
    cleanup_old
}

ensure_key

# Копия по требованию, не дожидаясь ночи:
#   docker compose run --rm backup now
if [ "${1:-}" = "now" ]; then
    log "Ручной запуск: делаю копию сейчас."
    run_once
    exit
fi

show_key
log "Расписание: каждый день в $AT. Хранение: $KEEP_DAYS дн. здесь, на сервере — 30 дн."

# Первая копия сразу после установки: чтобы не ждать ночи и сразу увидеть, что всё работает
if [ -z "$(find "$BACKUP_DIR" -name 'vkbot-*.sql.gz' -print -quit 2>/dev/null)" ]; then
    log "Копий ещё нет — делаю первую."
    run_once || log "Первая копия не удалась, следующая попытка в $AT."
fi

# Проверяем время раз в минуту: так не нужен планировщик, и перезапуск контейнера
# не сбивает расписание. Дата последнего запуска не даёт сделать две копии подряд.
while true; do
    now=$(date '+%H:%M')
    today=$(date '+%Y-%m-%d')
    if [ "$now" = "$AT" ] && [ "$(cat "$STATE" 2>/dev/null || echo)" != "$today" ]; then
        echo "$today" > "$STATE"
        run_once || true
    fi
    sleep 60
done
