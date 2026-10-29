# «искренне.» — локально подготовленный backend

> Ниже описана исходная подготовка backend без запуска. В Android 0.2.0 добавлен HTTPS-клиент для api.productivumtesting.ru; актуальные результаты и блокер сетевой проверки — [API_INTEGRATION.md](../docs/API_INTEGRATION.md). Исторические утверждения о неизменённом Android относятся к предыдущему этапу.

Изолированный небольшой сервис на JavaScript: встроенный `node:http`, драйвер `pg` и PostgreSQL. Ровно три операции на `/stories`: случайное чтение, создание и удаление по полному тексту. Android-проект не изменён, мобильные истории и черновики сюда автоматически не передаются.

**Контейнеры, Node.js-приложение и PostgreSQL в ходе подготовки не запускались. Интеграцию и работоспособность нужно проверить самостоятельно.** Домен не опрашивался, развёртывание не выполнялось.

## Структура и версии

```text
src/config.js       обязательные настройки и порт
src/validation.js   единая нормализация POST/DELETE
src/database.js     пул pg и три SQL-запроса
src/http.js         HTTP, JSON, Bearer-проверка, ошибки
src/server.js       запуск и завершение
src/errors.js       внутренние типы ошибок
sql/001-stories.sql начальная схема без данных
compose.yaml        backend + postgres + named volume
Dockerfile          npm ci и непривилегированный пользователь node
requests.http       необязательные примеры для VS Code REST Client
requests/story.json готовая валидная многострочная история
requests/generate-cases.js генератор файлов для ручных проверок
```

Образы закреплены: `node:24.22.2-bookworm-slim` и `postgres:18.6-bookworm`; зависимость `pg` — `8.23.1`, npm lockfile v3. Node.js 24 — поддерживаемая LTS-ветка, PostgreSQL 18 — поддерживаемая стабильная ветка. Метаданные сверены **29.10.2026**: [релиз Node.js](https://nodejs.org/en/blog/release/v24.22.2), [официальные теги Node](https://github.com/docker-library/official-images/blob/master/library/node), [поддержка PostgreSQL](https://www.postgresql.org/support/versioning/), [официальный образ PostgreSQL](https://hub.docker.com/_/postgres). Новые патчи следует обновлять осознанно с повторной проверкой; `latest` не используется.

Для PostgreSQL 18 named volume смонтирован в `/var/lib/postgresql`, данные образа — в `/var/lib/postgresql/18/docker`. Порт 5432 **не опубликован**. Backend подключается к имени сервиса `postgres:5432` через частную Compose-сеть, без TLS внутри неё. Это не подключение мобильного клиента к БД.

## Настройка и запуск пользователем

Требуется уже подготовленное окружение с Docker Engine и Docker Compose v2. Для необязательной проверки синтаксиса и генерации JSON нужен установленный Node.js 22–26 (для сервиса выбран образ Node.js 24 LTS). Установка системных компонентов не входит в эту задачу.

Из этой директории на сервере/Linux:

```bash
umask 077
cp .env.example .env
# Отредактируйте .env: задайте собственные POSTGRES_PASSWORD и ADMIN_TOKEN.
# Для генерации 32 случайных байт можно использовать существующий менеджер секретов
# или, если OpenSSL уже установлен: openssl rand -hex 32
```

На Windows: `Copy-Item .env.example .env`, затем откройте `.env` в редакторе. Файл содержит секреты, исключён из Git и Docker build context; не коммитьте и не прикладывайте его к диагностике. Не оставляйте значения `REPLACE_*`: backend отклоняет их при запуске. Для паролей с `$` используйте одинарные кавычки в `.env`, чтобы Compose не интерполировал их. Рекомендуется отдельный случайный ADMIN_TOKEN из 64 hex-символов. Встроенного/резервного токена нет.

| Переменная `.env` | Назначение |
| --- | --- |
| `POSTGRES_DB` | Имя БД при первом создании volume |
| `POSTGRES_USER` | Роль, создаваемая официальным образом; используется backend |
| `POSTGRES_PASSWORD` | Обязательный непустой пароль БД |
| `ADMIN_TOKEN` | Обязательный Bearer-токен только для DELETE, без пробелов |
| `PORT` | HTTP-порт внутри контейнера и опубликованный порт, по умолчанию 3010 |

Compose передаёт backend `PGHOST=postgres`, `PGPORT=5432`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `ADMIN_TOKEN`, `PORT`. При запуске Node.js вне Compose эти PG-переменные надо передать самостоятельно: обязательны PGHOST/PGDATABASE/PGUSER/PGPASSWORD и ADMIN_TOKEN, PGPORT по умолчанию 5432. Сам сервис `.env` с диска не читает. Неверные/отсутствующие обязательные настройки завершают запуск с кодом 1 и безопасным сообщением с именем настройки.

```bash
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 backend postgres

# Остановка без удаления записей:
docker compose down
# Следующий запуск использует прежний volume при том же Compose project name:
docker compose up -d
```

При стандартном PORT публикуется **3010:3010**, backend слушает **0.0.0.0**. PostgreSQL healthcheck проверяет TCP-готовность, backend ожидает `service_healthy`. Пул подключается по мере запросов; потеря БД после запуска должна возвращать 503.

На SIGTERM/SIGINT backend прекращает принимать соединения, ожидает HTTP-запросы и закрывает пул. Максимум на завершение — 15 секунд, Compose даёт 20 секунд; при превышении срока процесс аварийно завершается с кодом 1. SQL ограничен `statement_timeout=10s`, соединение — 5s. Отдельного HTTP health endpoint нет.

Named volume сохраняет данные при перезапуске и обычном `docker compose down`. **Удаление volume уничтожает данные**; не используйте удаление volume как обычную остановку или способ применить SQL. Изменение Compose project name может подключить новый пустой volume вместо существующего.

`sql/001-stories.sql` автоматически выполняется entrypoint образа только при создании пустого каталога данных. Не на каждом запуске. `CREATE TABLE IF NOT EXISTS` допускает повторное ручное применение без удаления строк, но не изменяет несовместимую существующую схему. Сервис не создаёт схему на каждом запросе и не заводит таблицу миграций. Начальное состояние — пустая таблица, без мобильных демо-текстов.

## Схема и контракт

```sql
CREATE TABLE IF NOT EXISTS public.stories (
    content TEXT NOT NULL
);
```

Одна прикладная таблица, один явный столбец. ID, ключей, timestamps, индексов и уникальности текста нет. Повторный POST создаёт ещё одну строку; DELETE удаляет **все** строки с точно совпадающим нормализованным текстом одним параметризованным запросом и использует `rowCount`, без предварительного SELECT. Сравнение явно использует collation C, без регистронезависимого или Unicode-нормализующего сопоставления.

| Запрос | Успех | Дополнительные статусы |
| --- | --- | --- |
| `GET /stories` | 200, `text/plain; charset=utf-8`, только полный текст без JSON и добавленного перевода строки | 204 без тела, если таблица пуста |
| `POST /stories` | 201 без тела, только после INSERT | 400/413/415 |
| `DELETE /stories` | 204 без тела, если удалена хотя бы одна строка | 401 при отсутствии/неверном токене; 404 при отсутствии совпадений; 400/413/415 |

GET и POST не требуют токена. Каждая выдача GET независима: `ORDER BY random() LIMIT 1`, повторы разрешены. GET не пишет в БД, не хранит просмотры, сессии или очередь. Ответы имеют `Cache-Control: no-store`.

POST и DELETE принимают только JSON-объект `{"content":"..."}` с единственным полем строкового типа. `Content-Type: application/json`, необязательный charset UTF-8; сжатие тела не поддерживается. Краевые Unicode-пробелы (White_Space и U+FEFF) удаляются одной общей функцией; внутренние пробелы и переводы строк сохраняются. После нормализации допустимо **300–10 000 Unicode code points** включительно. Emoji вне BMP считаются одним code point; составные emoji и combining marks могут состоять из нескольких. Молчаливого обрезания нет. NUL и некорректные одиночные UTF-16-суррогаты отклоняются.

Тело ограничено **128 KiB фактических UTF-8-байтов**, включая JSON-экранирование, и при Content-Length, и при chunked transfer. Даже 10 000 emoji, полностью записанных как пары `\uXXXX`, укладываются в лимит. Большое количество краевых пробелов всё равно учитывается в байтовом лимите.

Ошибки — JSON `{"error":"код"}` без SQL, stack trace, текста запроса или реквизитов:

| Статус | `error` |
| --- | --- |
| 400 | `invalid_request` — JSON/тип/поля/длина/NUL/Unicode |
| 401 | `unauthorized`, также `WWW-Authenticate: Bearer realm="stories"` |
| 404 | `not_found` — неизвестный путь или DELETE без совпадений |
| 405 | `method_not_allowed`, `Allow: GET, POST, DELETE` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 503 | `service_unavailable` — соединение, остановка/перегрузка БД, SQL timeout |
| 500 | `internal_error` — непредвиденная ошибка, в том числе неверная схема |

На DELETE токен проверяется до чтения/валидации тела, поэтому запрос без верного токена получает 401 независимо от содержимого тела. PUT/PATCH/HEAD/OPTIONS не поддерживаются; для `/stories` ответ 405. По правилам HTTP ответ HEAD не имеет тела, включая ошибки. Протокольные ошибки HTTP возвращают статический JSON (400, 408 либо 431). Путь точный, `/stories/` не является вторым маршрутом; query string не используется.

Логи backend содержат только фиксированные коды событий и номер порта. Тексты историй, тела, токен, SQL и исходные объекты ошибок в них не логируются. Проверка токена сравнивает SHA-256 digest через `timingSafeEqual`; хеш токена не хранится в БД. Это административный общий секрет, не система пользовательской авторизации.

В Compose также явно выключены обычное логирование SQL-операторов и логирование значений bind-параметров PostgreSQL, включая ошибки (`log_statement=none`, оба `log_parameter_max_length*=0`); сообщения о состоянии и ошибках БД остаются. Настройки сверены с [документацией PostgreSQL 18](https://www.postgresql.org/docs/18/runtime-config-logging.html).

## Готовые запросы для ручной проверки

Примеры ниже выполняются **самим пользователем после запуска** на доверенном localhost. В PowerShell используйте `curl.exe` вместо алиаса `curl`.

```bash
# Новая пустая БД: 204 без тела.
curl -i http://127.0.0.1:3010/stories

# Полноценный русский пример >300 code points уже лежит в файле.
curl -i -X POST http://127.0.0.1:3010/stories \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @requests/story.json

# 200, только полный текст; повторить несколько раз. Повторы допустимы.
curl -i http://127.0.0.1:3010/stories

# Повторить тот же POST: станет две одинаковые строки.
curl -i -X POST http://127.0.0.1:3010/stories \
  -H 'Content-Type: application/json' --data-binary @requests/story.json

# Без токена и с неверным токеном: 401.
curl -i -X DELETE http://127.0.0.1:3010/stories \
  -H 'Content-Type: application/json' --data-binary @requests/story.json
curl -i -X DELETE http://127.0.0.1:3010/stories \
  -H 'Authorization: Bearer deliberately-wrong-manual-token' \
  -H 'Content-Type: application/json' --data-binary @requests/story.json
```

Для правильного DELETE передайте в окружение shell тот же ADMIN_TOKEN, что в `.env`. В Bash можно ввести его без записи литерала в историю команд:

```bash
read -rsp 'ADMIN_TOKEN: ' ADMIN_TOKEN; printf '\n'
curl -i -X DELETE http://127.0.0.1:3010/stories \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @requests/story.json
# 204: удалены обе строки. Повторить тот же DELETE: 404.
unset ADMIN_TOKEN
# Если других записей нет, следующий GET вернёт 204.
```

Можно пользоваться `requests.http` в VS Code REST Client: он читает ADMIN_TOKEN через dotenv-переменную. Не публикуйте историю запросов с раскрытыми секретами.

Граничные файлы подготовит генератор, который только пишет JSON и не обращается к API:

```bash
node requests/generate-cases.js
curl -i -X POST http://127.0.0.1:3010/stories \
  -H 'Content-Type: application/json' --data-binary @requests/generated/300.json
```

Заменяйте имя файла и сверяйте ожидаемый результат:

| Файл в `requests/generated/` | POST |
| --- | --- |
| `299.json`, `10001.json`, `whitespace.json` | 400 |
| `300.json`, `10000.json`, `emoji.json`, `escaped-emoji-10000.json` | 201 |
| `formatting.json` | 201; GET должен сохранить внутренние пробелы/абзацы и убрать только края |
| `nul.json`, `surrogate.json`, `wrong-type.json`, `missing.json`, `unknown.json`, `array.json`, `invalid-json.json` | 400 |
| `oversized.json` | 413 |

Для проверки конкретного текста через GET используйте отдельную тестовую БД/volume с единственной записью; при нескольких строках выбор случаен. Не удаляйте volume с нужными данными ради теста. DELETE с правильным токеном и теми же валидными файлами должен удалить все совпадения; повторный DELETE — 404.

Дополнительно вручную:

```bash
curl -i -X POST http://127.0.0.1:3010/stories \
  -H 'Content-Type: text/plain' --data-binary @requests/story.json # 415
curl -i -X PUT http://127.0.0.1:3010/stories # 405 + Allow
curl -i -X PATCH http://127.0.0.1:3010/stories # 405 + Allow
curl -i http://127.0.0.1:3010/unknown # 404

# На тестовом стенде: сначала сохраните запись, затем проверьте её после перезапуска.
docker compose restart
curl -i http://127.0.0.1:3010/stories

# Проверка ошибки БД на тестовом стенде; backend оставьте работающим.
docker compose stop postgres
curl -i http://127.0.0.1:3010/stories # ожидается 503
docker compose start postgres
# Дождитесь healthy; следующий GET должен снова работать.
```

Все эти запросы/генератор/перезапуски — **инструкции**, а не выполненные Codex проверки. POST создаёт реальные строки; использованные валидные тестовые истории после проверки удаляются правильным DELETE. На данных сервиса не выполняйте очистку volume.

## Внешний адрес и границы задачи

`http://productivumtesting.ru:3010/stories` появится только после фактического развёртывания и настройки доступности. Сейчас наличие сервиса по этому адресу не заявляется. Домен не является хостом PostgreSQL.

Nginx, HTTPS, DNS, firewall и хостинг ещё не настроены. **ADMIN_TOKEN нельзя передавать через публичный HTTP**: до настройки HTTPS выполняйте DELETE на самом сервере через localhost либо через доверенный SSH-туннель. Compose публикует backend на всех интерфейсах; ограничения внешнего доступа относятся к отдельной настройке сервера. В этой версии POST публичен, нет модерации, аккаунтов, rate limiting и синхронизации. Переход мобильного приложения на API — отдельная задача и требует отдельного согласия на передачу локальных записей.

## Что проверено при подготовке

- Изучены существующий Android README, структура и пустая папка backend; применимых AGENTS.md и готовой backend/test-инфраструктуры не найдено. `git status` недоступен: рабочая папка не является Git checkout. Созданы только файлы внутри backend.
- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`: сформирован lockfile, без установки node_modules и без lifecycle-скриптов.
- `npm run check`: только `node --check` всех JS-файлов, без выполнения модулей; успешно на имеющемся Node.js 22.22.2 / npm 10.9.7.
- Выполнены статическое чтение/review SQL, маршрутов, обработки ошибок, конфигурации, Dockerfile/Compose, портов, volume, ignore-файлов и соответствия lockfile. JSON-пример проверен как файл данных, его длина допустима. Результаты доступных дополнительных статических проверок фиксируются в VALIDATION.md.
- Type checker, formatter и отдельный linter — не применимо: их не было, новые инструменты не добавлялись. Существующих тестов backend для обновления не было; автоматические функциональные тесты не создавались и не запускались.
- **Docker/Compose/PostgreSQL не устанавливались, контейнеры, приложение, PostgreSQL и функциональные/интеграционные тесты не запускались.** Docker build/config и SQL на живой БД не проверялись. Сигналы завершения и весь HTTP-контракт с PostgreSQL предстоит проверить пользователю. Android и настройки хостинга не изменены.
