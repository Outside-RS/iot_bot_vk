#!/bin/sh
# Сторож туннеля до сервера.
#
# Зачем он нужен. frpc не всегда восстанавливается сам: после обрыва связи он
# может остаться в бесконечном цикле «connect to server error: i/o deadline
# reached» даже тогда, когда сеть уже вернулась. Процесс при этом жив и
# здоров с точки зрения Docker, поэтому restart: unless-stopped не срабатывает,
# а результат такой: бот отвечает студентам как ни в чём не бывало, но админка
# снаружи недоступна, и понять почему без логов невозможно. Лечилось это
# вручную — docker compose restart frpc.
#
# Скрипт запускает frpc и раз в CHECK_INTERVAL секунд спрашивает состояние у
# его же веб-интерфейса (webServer в frpc.toml). Если туннель не в состоянии
# running FAILS_LIMIT проверок подряд — завершаем frpc и выходим с ошибкой,
# после чего Docker поднимает контейнер заново с чистого листа.
#
# Несколько неудачных проверок подряд, а не одна: короткие обрывы связи frpc
# переживает сам, и перезапускать контейнер из-за каждого моргания сети значит
# рвать рабочие соединения на ровном месте.

CONFIG=${FRPC_CONFIG:-/etc/frp/frpc.toml}
API=${FRPC_API:-http://127.0.0.1:7400/api/status}
CHECK_INTERVAL=${CHECK_INTERVAL:-60}
FAILS_LIMIT=${FAILS_LIMIT:-3}
# Первая проверка не сразу: frpc нужно время на подключение и регистрацию
GRACE=${GRACE:-30}

# Без webServer в конфиге спрашивать состояние не у кого. В этом случае
# работаем как обычный frpc, без присмотра: иначе сторож считал бы недоступный
# интерфейс поломкой и перезапускал контейнер каждые несколько минут.
if ! grep -q "webServer" "$CONFIG"; then
    echo "[watchdog] в $CONFIG нет webServer — запускаю frpc без присмотра"
    echo "[watchdog] чтобы включить, добавьте в конфиг: webServer.addr = \"127.0.0.1\" и webServer.port = 7400"
    exec /usr/bin/frpc -c "$CONFIG"
fi

/usr/bin/frpc -c "$CONFIG" &
FRPC=$!

# Чтобы docker compose stop останавливал контейнер сразу, а не ждал таймаута
trap 'kill "$FRPC" 2>/dev/null; exit 0' TERM INT

sleep "$GRACE"

fails=0
while :; do
    if ! kill -0 "$FRPC" 2>/dev/null; then
        wait "$FRPC"
        code=$?
        echo "[watchdog] frpc завершился сам, код $code"
        exit "$code"
    fi

    if wget -q -T 10 -O - "$API" 2>/dev/null | grep -q '"status": *"running"'; then
        fails=0
    else
        fails=$((fails + 1))
        echo "[watchdog] туннель не работает, проверка $fails из $FAILS_LIMIT"
        if [ "$fails" -ge "$FAILS_LIMIT" ]; then
            echo "[watchdog] перезапуск контейнера"
            kill "$FRPC" 2>/dev/null
            sleep 2
            kill -9 "$FRPC" 2>/dev/null
            exit 1
        fi
    fi
    sleep "$CHECK_INTERVAL"
done
