# AI в Docker рядом с существующей Ollama

Основной запуск на Ubuntu теперь — Docker Compose. `compose.override.yaml` автоматически дополняет существующий `compose.yaml` сервисами ai-migrate, ai-api, ai-worker и ollama-relay. Файл compose.yaml **не изменён**: сохраните именно серверный вариант с `127.0.0.1:3011:3010`, прежней БД и прежним named volume. Не заменяйте его локальным вариантом, у которого исторически другой host-port.

Путь запроса:

```text
Postman → HTTPS api.productivumtesting.ru
        → Nginx /ai/ → 127.0.0.1:3012
        → ai-api (контейнер, внутри слушает 0.0.0.0:3012)
        → PostgreSQL: задача → ai-worker
        → Unix socket в named volume → ollama-relay (host network)
        → http://127.0.0.1:11434/api/chat → существующая Ollama
```

AI-контейнеры работают в той же bridge-сети, что postgres: `PGHOST=postgres`, 5432 без публикации. Никаких динамических IP в .env. PGDATABASE/PGUSER/PGPASSWORD Compose берёт из существующих POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD. Ранее добавленные host-side PG_* из .env в этих контейнерах не используются.

Ollama остаётся на loopback хоста. Relay использует Linux host network только для исходящих запросов к ней; **сам relay не слушает TCP-порт**, только `/run/ollama-relay/ollama.sock`. Socket volume доступен API и worker, сокет имеет mode 0600; все процессы образа работают как node. Только relay имеет host network. Docker socket не монтируется. Не требуется менять OLLAMA_HOST, firewall, драйверы или открывать 11434 наружу. Bridge-контейнеры не используют ошибочный localhost/host.docker.internal для обращения к loopback-only Ollama.

Relay допускает только GET /api/version, POST /api/show и POST /api/chat на фиксированный upstream, ограничивает тело/ответ и не передаёт Authorization. При неопределённом обрыве он рвёт транспорт: worker сохраняет блокирующий gate, как и при прямом вызове, вместо небезопасного автоматического повторения генерации. Загрузка и генерация по-прежнему выполняются через единственную общую PostgreSQL-очередь. Relay не даёт обходить её через публичный HTTP.

## Первый запуск на сервере

1. Перенесите изменённые исходники backend, Dockerfile, .dockerignore и **новый compose.override.yaml** в `/opt/backend-sincerity`. Сохраните текущий серверный compose.yaml, `.env`, Nginx, проект Compose и postgres_data. Не копируйте пример окружения поверх действующего `.env`.
2. В текущем `.env` нужны существующие POSTGRES_* и ADMIN_TOKEN, а также AI_SERVICE_KEY (отдельный случайный ключ 32–256 символов) и AI_PORT=3012. При отсутствии ключа: `node scripts/generate-ai-key.js`. Существующий валидный ключ сохраняется; при значении `test` сначала очистите AI_SERVICE_KEY, затем запустите генератор. Не присылайте секреты в чат. Остальные лимиты имеют defaults из override.
3. Завершите старый ручной AI API/worker корректным SIGTERM или Ctrl+C, либо остановите только их systemd units, если они были установлены. Убедитесь, что 3012 освободился: `sudo ss -ltnp '( sport = :3012 )'`. Не останавливайте stories, PostgreSQL, Ollama и чужие сервисы. Если старый worker был принудительно убит во время генерации, сначала подтвердите завершение её в Ollama и выполните documented recover, прежде чем разрешать новые задачи.
4. Сохраните резервную копию действующей БД принятым способом. Из того же каталога/Compose project выполните:

```bash
cd /opt/backend-sincerity
docker compose config --quiet
docker compose config --services
docker compose build ai-api
docker compose up -d --no-build ai-api ai-worker
docker compose ps -a
docker compose logs --tail=100 ai-migrate ollama-relay ai-api ai-worker
```

`config --services` должен показать новые AI-сервисы. Не публикуйте обычный `docker compose config`: он может вывести секреты. Если используется нестандартное имя base-файла, COMPOSE_FILE или явный `-f`, auto-override может не подключиться; используйте **оба** файла, например `docker compose -f compose.yaml -f compose.override.yaml ...` для всех команд. Не меняйте `-p`/COMPOSE_PROJECT_NAME — от этого зависит сохранение существующей сети и volume.

Сборка ai-api создаёт общий образ для четырёх новых сервисов. Команда up запускает их зависимости: существующий healthy postgres, одноразовую аддитивную миграцию и relay. Миграция повторяема, public.stories не меняется. После её успешного завершения и готовности socket relay стартуют API/worker. Ожидаемо ai-migrate будет Exited (0); остальные сервисы — Up. При Exited (1) смотрите его безопасный лог, не удаляйте volume.

Эти целевые команды не пересобирают и не заменяют действующий сервис backend на 3011. После первоначальной настройки обычный `docker compose up -d` поднимает весь проект, включая AI, а `docker compose restart ai-api ai-worker` перезапускает только их. После обновления исходников нужна **сборка образа**, одного restart недостаточно: повторите build ai-api и up -d --no-build ai-api ai-worker. Для явного повторного запуска миграции новой версии перед up можно выполнить `docker compose run --rm --no-deps ai-migrate` при healthy БД.

## Проверка

Сначала проверьте HTTP без ключа:

```bash
curl -i http://127.0.0.1:3012/ai/habit-summary
curl -i https://api.productivumtesting.ru/ai/habit-summary
```

Оба должны возвращать 401 с Bearer realm="ai". Это проверка HTTP/маршрута, **не генерации**. Если локальный работает, внешний — нет, проверяйте Nginx. Если локальный недоступен — ps/logs новых сервисов и конфликт 3012. При другом AI_PORT согласуйте upstream Nginx с опубликованным портом; внутри контейнера всегда 3012.

Проверка метаданных Ollama через контейнер/relay, без генерации:

```bash
docker compose exec ai-api node src/ai/cli.js inspect-ollama
```

Сервисный ключ в argv этой команды не передаётся. Затем выполните один короткий chat из Postman или curl:

```bash
read -rsp 'AI_SERVICE_KEY: ' AI_SERVICE_KEY
printf '\n'
curl -i --max-time 2000 \
  https://api.productivumtesting.ru/ai/v1/chat/completions \
  -H "Authorization: Bearer $AI_SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"stream":false,"max_tokens":100,"messages":[{"role":"user","content":"Коротко объясни пользу привычек."}]}'
unset AI_SERVICE_KEY
```

Ожидается 200 и choices[0].message.content. Холодный запуск может занять несколько минут. Если job failed/generation_blocked, сначала смотрите безопасные логи ai-worker/ollama-relay; правила подтверждённого восстановления из AI.md сохраняются. CLI внутри контейнера: `docker compose exec ai-api node src/ai/cli.js diagnose` и, только после подтверждения отсутствия старой генерации, `docker compose exec ai-api node src/ai/cli.js recover --confirmed-idle`.

В Postman Desktop: URL `https://api.productivumtesting.ru/ai/v1/chat/completions`, Authorization → Bearer Token → серверный AI_SERVICE_KEY, Body → raw → JSON как в curl. Секрет остаётся на стороне доверенного оператора/сервера, в React/Android не включается. Все четыре AI-маршрута из AI.md остаются прежними. Сводки по-прежнему описывают структуру generic JSON до появления контракта привычек.

## Nginx

Сохраняйте уже подготовленный location `/ai/` с `proxy_pass http://127.0.0.1:3012;` **без завершающего слеша** и proxy_read_timeout=2000s. Остальной `/` остаётся на 3011, SSL/Certbot не меняются. Готовый сниппет — deploy/nginx-ai.conf. Если location уже применён, менять его из-за контейнеризации не требуется. После ручного изменения: `sudo nginx -t && sudo systemctl reload nginx`. Backend/API, PostgreSQL и Ollama не должны получать новые публичные порты.

## Остановка и откат

```bash
docker compose stop ai-api ai-worker ollama-relay
```

Worker/relay могут ждать завершения текущего вызова до настроенного stop_grace_period. Не применяйте kill во время генерации без последующего подтверждённого восстановления. Для отката оставьте AI-схему и volume, восстановите прежний способ запуска AI (после освобождения 3012) либо прежнюю маршрутизацию Nginx с проверкой перед reload. Не используйте down -v: данные БД будут уничтожены. Обычный docker compose down также остановит stories/PostgreSQL — для остановки только AI используйте точечную команду выше.

При увеличении лимитов загрузки/генерации согласуйте stop_grace_period worker/relay и proxy_read_timeout Nginx с новыми временами; значения 2000s рассчитаны на стандартную конфигурацию.

## Что фактически проверено

На Windows: синтаксис 31 JS-файла; 30 тестов passed, 1 PostgreSQL suite skipped. Новые in-process тесты проверяют Docker-bind/config, Unix transport body/signal, allowlist relay, ограничения тела и различие definite/uncertain обрывов. Они не открывают listening port и не запускают Ollama/PostgreSQL/контейнеры. `git diff --check` успешен.

Docker CLI здесь отсутствует, поэтому Compose config/build/up, права Unix socket в реальном Docker volume, read-only mount, host networking Ubuntu и полный внешний запрос **не проверены**. Структура YAML/Dockerfile/переменных/зависимостей проверена чтением, не Docker-валидатором. SSH-доступа нет; на сервере ничего не применялось. Исходный compose.yaml, его postgres_data и Nginx не изменены. Ограниченный runtime smoke test выше выполняет оператор.

Официальные основания сетевой схемы: [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/), [service attributes](https://docs.docker.com/reference/compose-file/services/). Linux host network выбран для relay ради доступа к существующему loopback Ollama; остальные контейнеры сохраняют изоляцию bridge-сети.
