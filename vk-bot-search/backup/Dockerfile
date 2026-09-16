# Контейнер резервных копий: pg_dump из образа PostgreSQL той же версии,
# что и база, плюс клиент SSH для отправки копий на сервер.
FROM postgres:15-alpine

RUN apk add --no-cache openssh-client

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
