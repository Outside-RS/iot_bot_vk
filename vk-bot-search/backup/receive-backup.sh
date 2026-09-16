#!/bin/sh
# Приём резервной копии на сервере. Кладётся в /usr/local/bin/receive-backup.
#
# Эта команда жёстко привязана к ключу бота в authorized_keys: что бы ни прислал
# клиент, сервер выполнит только её. Оболочки, проброса портов и доступа
# к остальной системе у этого ключа нет.
set -eu

DIR="$HOME/backups"
KEEP_DAYS=30

mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077

# Время в UTC: часовой пояс сервера обычно отличается от пояса бота,
# и без пометки даты в двух списках копий выглядели бы противоречиво
file="$DIR/vkbot-$(date -u '+%Y-%m-%d_%H%M')-utc.sql.gz"
cat > "$file"

# Пустой или битый архив копией не считается
if [ ! -s "$file" ] || ! gzip -t "$file" 2>/dev/null; then
    rm -f "$file"
    echo "ОШИБКА: получен пустой или повреждённый файл, копия не сохранена" >&2
    exit 1
fi

find "$DIR" -type f -name 'vkbot-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

echo "принято: $(basename "$file"), $(du -h "$file" | cut -f1); всего копий: $(find "$DIR" -type f -name 'vkbot-*.sql.gz' | wc -l)"
