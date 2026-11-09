# Локальная Ollama: текущий контракт AI API

Сверено с исходниками репозитория 10.11.2026: `src/ai/http.js`, `validation.js`, `summary.js`, `repository.js`, `config.js`, `ollama.js`, `limits.js`, `worker.js` и Docker-конфигурацией. Это контракт текущего кода; версия запущенного на Ubuntu образа требует отдельной проверки после обновления и сборки.

Публичный base URL для Productivum: `https://api.productivumtesting.ru`, путь `/ai/` уже включён в маршруты ниже. Локальный адрес на Ubuntu-хосте при стандартном AI_PORT: `http://127.0.0.1:3012`. Основной запуск — [Docker Compose](DOCKER_AI.md); альтернативный host-side запуск приведён отдельно в конце документа.

Изменён только этот backend. Сервис историй `/stories` на прежнем порту, Android и frontend не изменяются. AI запускается отдельными контейнерами: опубликованный HTTP на **127.0.0.1:3012** и worker без HTTP-порта. Используется **та же PostgreSQL**, новая БД не создаётся. Новых npm-зависимостей нет. Host-side запуск остаётся доступен без OLLAMA_SOCKET_PATH; в нём bind по умолчанию 127.0.0.1. В Docker AI_BIND_HOST=0.0.0.0 внутри контейнера, а доступ с хоста ограничен loopback-публикацией.

## Принятый временный контракт

Пользовательской авторизации пока нет. **Все четыре AI-операции защищены одним отдельным `Authorization: Bearer <AI_SERVICE_KEY>`**. Токен передаётся без дополнительных кавычек внутри заголовка. Он не совпадает с ADMIN_TOKEN и не предоставляет DELETE `/stories`. Допускаются 32–256 символов `[A-Za-z0-9._~-]`. `npm run ai:key` сохраняет случайный ключ в исключённый из Git `.env`, не печатая значение. Повторная команда сохраняет существующий валидный ключ; неверный непустой ключ (например, `test`) нужно сначала очистить, иначе генератор завершится ошибкой.

Это серверная интеграция: Productivum должен обращаться со своего backend. Не передавайте ключ в React, Android, публичные env, URL или bundle. Запросы с Origin отклоняются; CORS не включён. Произвольный X-Forwarded-For не используется. Все обладатели ключа имеют доступ ко всем AI-источникам и статусам задач: **`source` — имя снимка, не пользователь и не граница доступа**. Аккаунтов, JWT и фиктивной проверки владельца нет.

Источник привычек и его схема ещё не определены. Сейчас **POST /ai/habit-summary** принимает произвольный JSON: объект, массив, строку, число, boolean или null, с ограничениями ниже. Для одного `source` хранится последний снимок; новый POST заменяет предыдущий, но предыдущий успешный отчёт остаётся до готовности нового. Это не история всех присланных событий.

**Текущий отчёт — обзор структуры JSON, а не статистика привычек.** Backend определяет тип значения и число полей/элементов верхнего уровня. Исходные имена, строки, клиентские проценты и другие значения в модель не передаются. Ollama выбирает заголовок и рекомендацию из проверенных вариантов JSON Schema; числовая строка сводки формируется backend и должна точно совпасть с enum схемы. Поэтому модель не может приписать число другой метрике, вставить HTML, инструкции или выдуманную статистику. Это намеренное ограничение до согласования схемы Productivum. Проценты выполнения, серии, расписания, архивирование и пользовательская история здесь **не реализованы**, поскольку входных правил и данных ещё нет.

Для свободного анализа содержимого данных сейчас используется **POST /ai/v1/chat/completions**. Он передаёт текст сообщений модели и возвращает текст синхронно; результат не становится сохранённым `report` источника. Вычисление достоверных числовых фактов и хранение такого анализа организует Productivum. Ключ, соответствие source/jobId пользователю и проверка принадлежности данных должны оставаться на backend Productivum; React обращается к нему, а не напрямую к AI API.

## Маршруты

| Метод и путь | Назначение | Успех |
| --- | --- | --- |
| POST /ai/v1/chat/completions | Свободный текстовый chat, синхронно | 200 |
| POST /ai/habit-summary | Сохранить JSON-снимок и создать/переиспользовать структурную сводку | 200 либо 202 |
| GET /ai/habit-summary | Прочитать последний отчёт/актуальность без генерации | 200, в том числе пустое состояние |
| GET /ai/jobs/:jobId | Прочитать статус задачи без её результата | 200 |

Оба POST требуют ровно один `Content-Type: application/json`; необязательный charset — только utf-8/utf8. Content-Encoding должен отсутствовать либо быть identity. Тело не более **64 KiB UTF-8 байт** (в том числе при chunked transfer), а не 64 тысячи символов. Этот предел учитывает JSON-обёртку и экранирование; он согласован с relay и Nginx-сниппетом. Неверный JSON/UTF-8 — 400; неверный тип/кодировка — 415; превышение размера — 413. Строки с NUL/непарными суррогатами не принимаются. Для снимка дополнительно проверяется глубина до 12 и конечность чисел; для chat действует отдельная строгая схема ниже.

GET не требует тела или Content-Type. Query допускается только у habit-summary; неизвестные/повторяющиеся параметры — 400. У chat/jobs любой непустой query string — 400. Пути с завершающим `/` не являются дополнительными маршрутами. Неизвестный путь — 404; неподдерживаемый метод — 405 с Allow. Проверка ключа выполняется раньше маршрутизации и чтения тела, поэтому запрос без корректного ключа получает 401. После авторизации непустой Origin отклоняется с 403.

Ответы обработчиков JSON: `application/json; charset=utf-8`, `Cache-Control: no-store`. Ошибки Nginx/HTTP-протокола могут отличаться; клиент должен учитывать Content-Type, а не всегда безусловно вызывать JSON parser.

### POST `/ai/habit-summary?source=productivum&timezone=Europe/Moscow&language=ru`

Тело — сам произвольный JSON, без обязательной обёртки. `source`: ASCII-буквы, цифры, `_`, `-`, 1–80 символов, по умолчанию `default`. `timezone`: IANA, по умолчанию AI_TIMEZONE, затем UTC. `language`: ru/en, по умолчанию ru. Каждый POST задаёт метаданные заново; для постоянной зоны/языка передавайте их каждый раз.

Поле userId внутри тела не выбирает источник и не проверяет владельца. Если разные пользователи отправляют POST без query source, они заменяют один и тот же снимок default. Productivum должен назначать стабильный source на своём backend и проверять его принадлежность пользователю.

- 200: тот же снимок и актуальный готовый отчёт; повторной генерации нет.
- 202: новая или уже существующая queued/running задача. Например:

```json
{
  "report": null,
  "period": {"start": "2026-11-02", "end": "2026-11-08"},
  "timezone": "Europe/Moscow",
  "current": false,
  "jobId": "9a566fc2-2665-4dd4-8be3-048b36790ac1",
  "state": "queued",
  "statusUrl": "/ai/jobs/9a566fc2-2665-4dd4-8be3-048b36790ac1"
}
```

Тело, например `{"habits":[{"name":"Прогулка","completed":true}]}`, имеет одно поле верхнего уровня. Сводка сообщит число полей 1, не число привычек и не процент выполнения. Это пример произвольного JSON, не согласованная схема трекера.

При переиспользовании активной задачи ответ также 202; state может быть running. При 200 возвращаются `report`, `period`, `timezone`, `current:true`, `state:"succeeded"`; `jobId`/`statusUrl` в этом ответе отсутствуют. POST не возвращает вложенное поле `job` — оно относится к GET ниже. `statusUrl` уже содержит `/ai/`; разрешайте его относительно base URL, не добавляя префикс повторно.

Параллельные одинаковые запросы получают одну задачу. При перегрузке 429/503 снимок не заменяется: транзакция откатывается, запрос можно повторить позже.

### GET `/ai/habit-summary?source=productivum`

Допускается только query `source`, с тем же форматом/default, что в POST. Передавать timezone/language в GET не нужно: используются сохранённые метаданные, а неизвестные параметры отклоняются.

200 с `report`, `current`, `state`, `job`; для существующего источника также `period` и `timezone`. До первого POST: `{"report":null,"current":false,"state":"empty","job":null}`. Готовый `report` содержит ровно `title`, `summary`, `advice`, `generatedAt`; дата формируется backend в UTC. Во время обновления возвращается предыдущий отчёт с `current:false`. GET не меняет снимок и не ставит задачу; модель не вызывается. Технический rate limiter пишет счётчики запросов.

Полный пример текущего ответа для такого снимка (UUID/даты и выбор заголовка/совета — иллюстративные):

```json
{
  "report": {
    "title": "Поступившие данные",
    "summary": "Получен JSON-объект. Полей верхнего уровня: 1.",
    "advice": "Согласуйте схему привычек и отметок перед расчётом прогресса.",
    "generatedAt": "2026-11-09T20:01:00.000Z"
  },
  "current": true,
  "state": "succeeded",
  "job": {
    "jobId": "9a566fc2-2665-4dd4-8be3-048b36790ac1",
    "state": "succeeded",
    "error": null
  },
  "period": {"start": "2026-11-02", "end": "2026-11-08"},
  "timezone": "Europe/Moscow"
}
```

`current` — единственный флаг актуальности отчёта относительно последнего снимка и текущего локального периода. Наличие report или `state:"succeeded"` само по себе актуальность не гарантирует: после смены периода current может быть false при succeeded последней задачи. Верхнее state: succeeded при актуальном отчёте, иначе состояние последней задачи; если задач уже нет — stale. До появления источника state=empty. Вложенный job — последняя задача этого источника (либо null), а не обязательно задача для текущего периода; в нём только jobId/state/error.

### GET `/ai/jobs/:jobId`

jobId должен иметь формат UUID v4 из ответа POST. Query string не поддерживается. 200: jobId, state (queued/running/succeeded/failed), безопасный error либо null, createdAt (UTC ISO timestamp) и completedAt (UTC ISO timestamp либо null). Для сводки с сохранённым результатом задачи дополнительно published: было ли разрешено опубликовать отчёт. published=false означает, что исходный снимок/период устарел; задача при этом может быть succeeded.

payload, промпт, исходный JSON и текст chat не возвращаются. После succeeded сводку забирают GET /ai/habit-summary с тем же source. Успех операции определяется по state: в текущем коде error может сохранять код предыдущей неудачной попытки даже после успешного retry; непустой error не следует автоматически считать failed. То же относится к error во вложенном job ответа GET сводки.

Нет задачи или она уже удалена по сроку хранения — 404. Доступ по общему сервисному ключу, без выдуманных владельцев/администраторов. Запрос статуса также может отметить просроченную queued-задачу failed с queue_timeout; генерацию он не запускает.

### POST `/ai/v1/chat/completions`

Поддерживаемое подмножество Chat Completions:

```json
{"model":"qwen3.5:35b-a3b-q4_K_M","stream":false,"max_tokens":200,"messages":[{"role":"user","content":"Коротко объясни пользу расписания."}]}
```

Разрешены только `messages`, необязательные `model`, `stream:false`, `max_tokens`. Модель фиксирована. От 1 до 8 текстовых сообщений; роли system (только первым), user, assistant; нужен user и последнее сообщение user. Внутри сообщения только role/content. Суммарно **6144 UTF-8 байта (6 KiB) текста всех content**, непустые строки. `max_tokens`: целое от 1 до AI_MAX_TOKENS; default AI_MAX_TOKENS=512, настраиваемый серверный максимум 1024. Отсутствующий max_tokens использует серверный лимит, null отклоняется.

Контекст Ollama — **8192 токена**. Вход ограничен байтовым консервативным конвертом: bytes(content) + запрошенный max_tokens + резерв 1024 ≤ 8192; резерв отведён под шаблон/роли. Это **не точный подсчёт токенов**. При наличии обоих корректных фактических счётчиков дополнительно проверяется prompt_eval_count + max_tokens ≤ 8192 и eval_count ≤ max_tokens; иначе usage не включается. Сам запрос не может менять num_ctx или передавать произвольные options.

Переданный владельцем system-промпт Productivum («Ты — персональный помощник Productivum…», summary/advice) занимает **2183 UTF-8 байта**, 1230 Unicode code points. Старый предел 2048 отклонял даже system + user="{}". Новый предел оставляет **3961 байт** на суммарное содержимое остальных сообщений; это не обещание вместить JSON статистики любого размера. Точная строка и тесты сохранены в [test/fixtures/productivum-system.js](test/fixtures/productivum-system.js) и [test/prompt-budget.test.js](test/prompt-budget.test.js).

На стороне Python можно компактно сформировать user content и проверить размер до запроса:

```python
content = json.dumps(statistics, ensure_ascii=False, separators=(",", ":"))
messages = [
    {"role": "system", "content": SYSTEM},
    {"role": "user", "content": content},
]
assert sum(len(m["content"].encode("utf-8")) for m in messages) <= 6144
payload = {"stream": False, "max_tokens": 512, "messages": messages}
```

Здесь json — стандартный модуль Python, statistics — подготовленные Productivum факты. ensure_ascii=False сокращает именно строку content со статистикой; Unicode-экранирование внешнего HTTP JSON допустимо и покрывается лимитом тела 64 KiB. Просьба «Верни только JSON» в system не включает JSON Schema для chat: Productivum должен проверять finish_reason и разбирать/валидировать choices[0].message.content самостоятельно.

Tools, images, options, URL, temperature, загрузка/выгрузка модели и любые неизвестные поля клиента запрещены. Никаких внешних AI-fallback. Ответ синхронный 200 с id, object=`chat.completion`, created, model, choices; finish_reason stop либо length. usage присутствует только при фактических корректных счётчиках Ollama. Поток и полная совместимость OpenAI API не заявляются. Chat-текст может быть произвольным: потребитель должен отображать его как текст, не выполнять HTML.

Результат модели находится в `choices[0].message.content`. Пример без необязательного usage:

```json
{
  "id": "chatcmpl-9a566fc2-2665-4dd4-8be3-048b36790ac1",
  "object": "chat.completion",
  "created": 1794254460,
  "model": "qwen3.5:35b-a3b-q4_K_M",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "Постоянное расписание помогает закреплять привычку."},
      "finish_reason": "stop"
    }
  ]
}
```

created — серверное время формирования ответа, Unix seconds. usage, если есть, содержит prompt_tokens/completion_tokens/total_tokens. length — допустимое завершение chat по лимиту, текст может быть обрезан; такой результат не следует считать гарантированно завершённым JSON. Структурированный ответ chat не обещается, response_format не поддерживается. Если передаётся JSON в content, его нужно сериализовать в строку; object/array вместо content отклоняются. Итоговый текст ограничен 16 KiB UTF-8, полный ответ Ollama /api/chat — 64 KiB.

Внутри chat тоже использует очередь, но внешний контракт остаётся синхронным: 202/jobId/statusUrl вместо ответа не выдаются. Диалог между запросами не хранится; нужную историю нужно повторно передавать в messages в пределах лимита. Chat не имеет source/timezone/language и не обновляет reports. Для долгого анализа Productivum может вызывать его из своей фоновой задачи и сохранять результат у себя.

### Ошибки

Ошибки обработчиков имеют JSON `{"error":"код"}` без исходных исключений. У сводок ошибки генерации после ответа 202 читаются в задаче; старый успешный отчёт сохраняется.

| Статус | Типовые коды / поведение |
| --- | --- |
| 400 | invalid_request, invalid_query, invalid_timezone, json_too_deep, invalid_unicode, invalid_number, unsupported_model, stream_not_supported, context_budget_exceeded |
| 401 | unauthorized; отсутствующий, неверный или дублированный Authorization |
| 403 | browser_access_disabled: непустой Origin |
| 404 | not_found: неизвестный путь, неверный формат/отсутствующая задача |
| 405 | method_not_allowed и Allow: POST для chat; GET, POST для habit-summary; GET для jobs |
| 413 | payload_too_large |
| 415 | unsupported_media_type |
| 429 | rate_limited (Retry-After: 60) или queue_full (Retry-After: 10) |
| 500 | internal_error |
| 502 | Ошибка chat-задачи: например upstream_unavailable, upstream_rejected, invalid_upstream_response, unsupported_ollama, upstream_uncertain; Retry-After: 10 |
| 503 | service_unavailable (БД), generation_blocked (Retry-After: 30), job_unavailable, либо failed chat с queue_timeout/client_disconnected (Retry-After: 10) |
| 504 | request_timeout или failed chat с кодом upstream_timeout; Retry-After: 10 |

Важное уточнение: тайм-аут/обрыв во время preload или генерации обычно означает неподтверждённое завершение и сохраняется как **upstream_uncertain**, поэтому chat вернёт **502**, а следующие новые задачи могут получить 503 generation_blocked. Не всякий тайм-аут — 504. Ошибки inspect до генерации могут остаться upstream_timeout и дать 504. Retry-After — минимальная пауза, не гарантия безопасности повторного POST; при generation_blocked требуется подтверждённое восстановление, а при потере chat-ответа возможна повторная генерация.

Один error-код может иметь разный статус в зависимости от этапа: context_budget_exceeded — 400 при превышении входного UTF-8 бюджета и 502 при отклонении фактических счётчиков ответа Ollama. Клиенту нужно учитывать и статус, и error.

На стороне Productivum проверяйте HTTP-статус и Content-Type: Nginx может вернуть HTML 400/413/502/504 вместо JSON приложения. Отдельного публичного health endpoint нет.

## Очередь, ночное расписание, кэш

Миграция `sql/002-ai.sql` транзакционно добавляет только schema ai: sources, jobs, reports, control, rate_limits. public.stories и её данные не меняются. Миграция повторяема. В текущем Docker Compose её запускает сервис **ai-migrate**, а API/worker ждут успешного завершения. Это отдельный шаг при запуске сервисов, не повторное исполнение init-скриптов PostgreSQL volume. В host-side режиме миграция применяется явно через CLI. Служебная БД/Redis не нужны.

Все экземпляры должны использовать одну БД. Admission-секция сериализована PostgreSQL advisory xact lock; SELECT FOR UPDATE + SKIP LOCKED и session advisory lock удерживают один слот на время worker inspect/load/generation, включая несколько worker. Уникальный partial index дополнительно защищает дедупликацию активных сводок. Отдельная CLI-команда inspect-ollama читает метаданные вне очереди и не запускает генерацию.

По умолчанию допускается **6 запросов за календарную минуту на общий ключ**, включая GET состояния/статусов, cache hits и запросы с последующей ошибкой валидации. Проверки ключа/Origin/пути/метода выполняются раньше rate limiter. Это не лимит на source или пользователя. Общий лимит — удвоенный AI_REQUESTS_PER_MINUTE; очередь общая для chat и сводок, максимум 8 queued/running задач. Для нескольких пользователей Productivum нужно централизовать polling и согласовать лимиты с нагрузкой; worker всё равно генерирует последовательно.

Worker подогревает модель пустым messages при первой задаче, затем использует keep_alive=30m и прогретую модель для следующих задач. Сам Ollama не запускается и не выгружается этим приложением. Существующие сторонние потребители Ollama не подчиняются нашим PostgreSQL-lock: ограничение одного вызова гарантируется **внутри этой интеграции**, не для произвольных приложений на сервере.

Очередь имеет срок ожидания (по умолчанию 120 секунд от создания задачи); загрузка и генерация — отдельные тайм-ауты. Подтверждённые временные отказы и невалидные/обрезанные структурные отчёты могут повторяться с backoff 1, 2 секунды, пока не исчерпаны AI_MAX_ATTEMPTS и исходный expires_at. После долгой загрузки/генерации срок может уже истечь, поэтому две попытки не гарантированы. Срок очереди не обрывает уже running вызов.

Если холодная загрузка первой задачи длится дольше срока ожидания, другие queued-задачи могут просрочиться, пока модель загружается. Это относится и к ночным пакетам; постановка задачи не гарантирует успешный отчёт для каждого источника.

HTTP-обработчик chat при завершении/отмене очищает результат и отменяет queued chat. Уже running вызов дожидается завершения, не освобождая слот раньше. Ответ без done=true, транспортный обрыв или тайм-аут **генерирующего запроса/preload**, завершение которого не подтверждено, оставляют постоянный блокирующий флаг. Ошибка чтения метаданных до генерации сама по себе такой флаг не ставит. После падения worker новый worker видит прежний active_job и блокирует генерацию: один только отпущенный advisory lock не считается доказательством остановки модели. Exactly-once внешняя генерация не обещается.

Повторный POST сводки переиспользует готовый кэш или активную задачу для того же ключа. После failed может быть создана новая задача. Chat не имеет Idempotency-Key, не кэшируется и может сгенерировать повторный ответ после ручного повторения запроса. Автоматический бесконечный retry POST на стороне Productivum не предусмотрен.

Максимальное ожидание синхронного chat на уровне обработчика: queueWaitMs + maxAttempts × (loadTimeoutMs + generationTimeoutMs) + 10000, при defaults **1930 секунд**, плюс небольшое время запросов к БД/проверки дедлайна. Это предельный бюджет, не обещание длительности/скорости. Nginx-сниппет использует proxy_read_timeout=2000s. При изменении лимитов нужно согласовать Nginx, HTTP-клиент Productivum и stop_grace_period worker/relay. Для асинхронных сводок POST не ждёт модель; polling делайте с backoff 10,20,40,60 секунд и соблюдайте Retry-After.

Планировщик встроен в worker, проверяет расписание примерно раз в минуту между задачами. Отдельный PostgreSQL session lock оставляет один логический scheduler. Источники выбираются порциями по 100. В 03:00 локального дня (или при первом проходе после этого времени) задача ставится один раз на сохранённый источник. Повторный локальный час при DST не дублирует дату; если час пропущен, обработка идёт в первый доступный момент после 03:00. Во время длительной генерации или простоя запуск задерживается; это не обещание точности cron до минуты. Пропущенные старые дни не догоняются массово: обрабатывается текущий локальный день.

Период кэша — последние 7 завершённых локальных календарных дней, текущий день исключён. **Это окно актуальности отчёта, а не фильтрация событий неизвестной схемы JSON.** Клиентский period внутри JSON не меняет его. Ключ включает source, канонический JSON, timezone, язык, период, модель, версии промпта (`json-structure-v1`) и схемы (`1`). Изменение снимка/периода делает отчёт устаревшим. Публикация сравнивает ключ с последним снимком и текущим периодом повторно в транзакции; старая задача не перезапишет новую.

В sources хранится последний снимок; задачи до завершения содержат свои копии данных. Снимок и последний отчёт сохраняются до замены. Публичных DELETE источника/отчёта, списков или API изменения расписания нет. Payload завершённой задачи очищается; chat-result удаляется после получения HTTP-обработчиком, при аварии — при следующей очистке после 5 минут. Завершённые задачи удаляются спустя сутки при очередном проходе worker. При выключенном/заблокированном worker очистка может задержаться. Резервные копии PostgreSQL подчиняются политике владельца сервера.

## Конфигурация

В `.env.example` перечислены параметры. В Docker источником настроек служит **compose.override.yaml**: PGHOST=postgres, PGPORT=5432, а PGDATABASE/PGUSER/PGPASSWORD автоматически берутся из существующих POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD в .env. Host-side PG_* и приватный IP контейнера для Docker не нужны. AI_SERVICE_KEY обязателен. ADMIN_TOKEN передаётся для проверки разделения ключей, но не авторизует AI-запросы.

В host-side режиме приложение получает PG_* и AI_* непосредственно из окружения/Node --env-file. Само приложение .env не читает. Node --env-file не подставляет `${...}`: задавайте значения явно. PGPORT имеет default 5432; остальные реквизиты подключения обязательны. Startup проверяет конфигурацию, соединение и запрос к ai.control до открытия HTTP-порта; отказ завершает процесс с безопасным сообщением.

| Параметр | По умолчанию |
| --- | --- |
| AI_PORT | В Docker это опубликованный host-port, default 3012 на 127.0.0.1; внутри контейнера принудительно 3012. В host-side режиме это порт Node.js; там 3010/3011/11434 отклоняются. Не назначайте AI опубликованный порт действующего сервиса |
| AI_BIND_HOST | Host-side default 127.0.0.1; Docker принудительно 0.0.0.0 внутри контейнера; других значений нет |
| OLLAMA_SOCKET_PATH | Host-side отсутствует: прямой TCP к 127.0.0.1:11434. Docker: /run/ollama-relay/ollama.sock; другой непустой путь отклоняется |
| AI_TIMEZONE | UTC |
| AI_QUEUE_LIMIT | 8 queued/running задач |
| AI_QUEUE_WAIT_MS | 120000 |
| AI_LOAD_TIMEOUT_MS | 600000 |
| AI_GENERATION_TIMEOUT_MS | 300000 |
| AI_MAX_TOKENS | 512 по умолчанию; допускается 1–1024. Старое явно заданное 350 сохраняется и ограничит request max_tokens значением 350 |
| AI_REQUESTS_PER_MINUTE | 6 на ключ; общий лимит вдвое больше |
| AI_MAX_ATTEMPTS | 2, максимум 3 |

В Docker ai-api/ai-worker находятся в bridge-сети с PostgreSQL. Их запросы к Ollama идут через Unix socket в named volume; relay с Linux host network обращается только к фиксированному http://127.0.0.1:11434 хоста. Relay не публикует TCP-порт, Ollama не открывается наружу, URL/опции не принимаются из пользовательского запроса. `/api/version`, `/api/show`, `/api/chat` — внутренние пути Ollama, не дополнительные публичные AI-маршруты.

В relay и клиенте ответ /api/show ограничен **1 MiB**, ответы /api/version и /api/chat — **64 KiB**. Отдельный лимит метаданных устраняет обрыв длинного template/license; итоговый текст chat по-прежнему не более 16 KiB. Ollama получает temperature=0.2, num_ctx=8192, num_predict из серверного лимита/запроса, stream=false, think=false, keep_alive=30m; сводки дополнительно format=JSON Schema. Более длинный контекст требует больше памяти; реальное потребление и скорость на сервере нужно измерить, как поясняет [документация Ollama](https://docs.ollama.com/context-length).

Справка: [официальный chat API](https://docs.ollama.com/api/chat), [структурированные ответы](https://docs.ollama.com/capabilities/structured-outputs), [preload](https://github.com/ollama/ollama/blob/main/docs/api.md), [каталог Qwen3.5](https://ollama.com/library/qwen3.5/tags). `inspect-ollama` проверяет /api/version и /api/show без генерации; worker затем проверяет фактический preload с think=false. Это не заменяет smoke test установленной версии. Скорость и размещение модели в VRAM не измерялись.

## Запуск и ручные запросы

Основное развёртывание — [DOCKER_AI.md](DOCKER_AI.md). Дополнительные сведения о Nginx, systemd и откате — [deploy/README.md](deploy/README.md). Серверные логи, предоставленные владельцем, подтверждали запуск AI API/worker/relay, успешную миграцию и доступность /api/version через socket. Успешная генерация текущим образом этим документом не подтверждается; локальные исходники и серверный образ нужно обновлять согласованно.

### Основной Docker-запуск

Сохраните текущие серверные compose.yaml, .env, COMPOSE_PROJECT_NAME и volume; compose.override.yaml добавляет новые сервисы, не меняя существующий проброс 3011 → 3010. Резервное копирование БД и освобождение 3012 от старых host-side AI-процессов описаны в DOCKER_AI.md. Из /opt/backend-sincerity:

```bash
docker compose config --quiet
docker compose config --services
docker compose build ai-api
docker compose up -d --no-build ollama-relay ai-api ai-worker
docker compose ps -a
docker compose logs --tail=100 ai-migrate ollama-relay ai-api ai-worker
docker compose exec ai-api node src/ai/cli.js inspect-ollama
```

ai-migrate должен завершиться с кодом 0; API/worker запускаются после него и готовности relay. Миграция находится в Docker-образе. Если auto-override не подключается из-за COMPOSE_FILE/явного -f, указывайте оба файла во всех командах: `docker compose -f compose.yaml -f compose.override.yaml ...`. Не выводите полный `docker compose config` в общие логи: он может содержать секреты.

После обновления исходников нужна сборка образа и up, одного restart недостаточно. При переходе со старых лимитов проверьте AI_MAX_TOKENS в действующем .env: если там 350, для request max_tokens=512 явно задайте AI_MAX_TOKENS=512. Никакие секреты в существующем .env не заменяются примером.

Nginx должен сохранять префикс: `proxy_pass http://127.0.0.1:3012;` без завершающего слеша. Для нового максимального тела в действующем location /ai/ установите **client_max_body_size 64k** и примените после успешного `nginx -t`. Сниппет — [deploy/nginx-ai.conf](deploy/nginx-ai.conf); действующий `/` остаётся на 3011. Если AI_PORT отличается, согласуйте host-port с Nginx. Секрет не записывается в Nginx.

### Альтернативный host-side запуск

В существующей среде Node LTS и с доступом к текущей БД:

```bash
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm run ai:key
# Дополните .env PG_* существующей БД и AI_*; не переписывайте текущие секреты.
node --env-file=.env src/ai/cli.js migrate
node --env-file=.env src/ai/cli.js inspect-ollama
# В двух отдельных терминалах, либо через подготовленные systemd units:
node --env-file=.env src/ai/server.js
node --env-file=.env src/ai/worker-main.js
```

`npm start` по-прежнему запускает stories. Docker Compose с override запускает AI отдельными сервисами. При альтернативном host-side запуске PGHOST должен быть доступен процессу Ubuntu через приватный маршрут; Docker DNS-имя postgres вне этой сети не работает. Указанный вручную IP контейнера может измениться при его пересоздании. Не открывайте PostgreSQL наружу. Не запускайте одновременно host-side и Docker AI на одном порту. Шаблоны systemd имеют WorkingDirectory=/opt/iskrenne-backend; при их использовании согласуйте его с фактическим /opt/backend-sincerity и путём Node.js.

### Ручные запросы к API

Готовые запросы — [ai.requests.http](ai.requests.http). Curl ниже выполняется пользователем после запуска. В Bash введите ключ без записи его литерала в историю:

```bash
read -rsp 'AI_SERVICE_KEY: ' AI_SERVICE_KEY
printf '\n'
export AI_SERVICE_KEY
BASE=http://127.0.0.1:3012
# После фактического развёртывания маршрута замените BASE:
# BASE=https://api.productivumtesting.ru

curl -i "$BASE/ai/habit-summary?source=productivum" \
  -H "Authorization: Bearer $AI_SERVICE_KEY"
curl -i -X POST "$BASE/ai/habit-summary?source=productivum&timezone=Europe/Moscow&language=ru" \
  -H "Authorization: Bearer $AI_SERVICE_KEY" -H 'Content-Type: application/json' \
  --data-binary @requests/ai-source.json
# Подставьте только UUID из ответа POST:
JOB_ID=REPLACE_WITH_JOB_UUID
curl -i "$BASE/ai/jobs/$JOB_ID" -H "Authorization: Bearer $AI_SERVICE_KEY"
# Повторяйте с backoff 10,20,40,60 секунд, соблюдая Retry-After; затем GET сводки.
curl -i "$BASE/ai/habit-summary?source=productivum" -H "Authorization: Bearer $AI_SERVICE_KEY"
curl -i --max-time 2000 "$BASE/ai/v1/chat/completions" \
  -H "Authorization: Bearer $AI_SERVICE_KEY" -H 'Content-Type: application/json' \
  --data '{"stream":false,"messages":[{"role":"user","content":"Ответь одним коротким предложением."}]}'
unset AI_SERVICE_KEY
```

Не повторяйте POST chat автоматически при потере ответа: идемпотентность chat не заявляется. Примеры общедоступного адреса не означают, что маршрут уже развернут или проверен.

## Ручной запуск и восстановление

Административные операции доступны только серверному оператору через CLI. В Docker:

```bash
docker compose exec ai-api node src/ai/cli.js summary productivum
docker compose exec ai-api node src/ai/cli.js diagnose
docker compose exec ai-api node src/ai/cli.js inspect-ollama
```

summary ставит/переиспользует задачу для **уже присланного** источника по тем же правилам дедупликации и кэша. Принудительного обхода кэша нет. diagnose показывает только агрегаты очереди и флаги gate, без имён, данных, промптов и ключей. inspect-ollama читает метаданные, не запускает генерацию. Host-side эквивалент: `node --env-file=.env src/ai/cli.js <команда>`.

Если generation_blocked: остановите все worker этой интеграции, оставив ai-api для CLI; подтвердите по состоянию/журналам Ollama, что прежний вызов завершился или отменён. `/api/ps` показывает загруженные модели, **не доказывает отсутствие активной генерации**. Не выгружайте/не перезапускайте общий Ollama без учёта других потребителей. Только после подтверждения отсутствия активного старого вызова:

```bash
docker compose exec ai-api node src/ai/cli.js recover --confirmed-idle
```

Host-side эквивалент: `node --env-file=.env src/ai/cli.js recover --confirmed-idle`. CLI откажет, если advisory lock ещё удерживает worker. Команда отмечает прерванную задачу failed и открывает gate; автоматического восстановления по истечению lease нет. Затем запустите worker и повторите необходимый POST сводки. Восстановление gate не должно выполняться автоматически из Productivum или по факту любого HTTP 502.

## Проверки

`npm run check` — синтаксис; `npm test` — Node test runner: моки HTTP/Ollama и native HTTP pipeline через временные named pipes Windows/Unix sockets Linux, без реальной модели и TCP-портов. Проверки PostgreSQL включаются **только явно**: AI_TEST_DATABASE_URL указывает отдельную пустую БД с именем `*_test`, AI_TEST_ALLOW_RESET=YES. Они создают и в finally удаляют только свою schema ai; при уже существующей ai-схеме откажут. Никогда не указывайте действующую БД. До этого нужен обычный `npm ci` для pg. Для проверки документации запуск этих сервисов не требуется.

Фактические результаты тестов/невыполненные runtime-проверки контейнеризации — [DOCKER_AI.md](DOCKER_AI.md#что-фактически-проверено); исходный исторический отчёт — [AI_VALIDATION.md](AI_VALIDATION.md). Аудит этого документа не подтверждает доступность домена, установленную серверную версию или успешную реальную генерацию.

## Сопоставление с реализацией

| Часть контракта | Источник |
| --- | --- |
| Пути, методы, JSON ответов, HTTP-статусы, auth/Origin, sync deadline | [src/ai/http.js](src/ai/http.js), общая JSON/Bearer-проверка в [src/http.js](src/http.js) |
| Поля chat, роли, UTF-8 бюджет, completion envelope | [src/ai/validation.js](src/ai/validation.js) |
| source/timezone/language, канонический JSON, период, enum-схема отчёта | [src/ai/summary.js](src/ai/summary.js) |
| Дедупликация, current/state/job, публикация, retry, retention, scheduler | [src/ai/repository.js](src/ai/repository.js), [src/ai/worker.js](src/ai/worker.js) |
| Переменные, defaults, bind/socket, лимиты ответов Ollama | [src/ai/config.js](src/ai/config.js), [src/ai/limits.js](src/ai/limits.js), [src/ai/ollama.js](src/ai/ollama.js) |
| Docker env, порты, миграция, relay/worker | [compose.override.yaml](compose.override.yaml), [Dockerfile](Dockerfile), [DOCKER_AI.md](DOCKER_AI.md) |
| Схема хранения и CLI | [sql/002-ai.sql](sql/002-ai.sql), [src/ai/cli.js](src/ai/cli.js) |
