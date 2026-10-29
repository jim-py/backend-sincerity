# Выполненные проверки — 29.10.2026

Выполнены только статические проверки и чтение документации. HTTP-сервер, PostgreSQL, контейнеры, функциональные и интеграционные тесты не запускались. Домен `productivumtesting.ru:3010` не опрашивался. Docker/Compose/PostgreSQL и инструменты проверки не устанавливались.

| Проверка | Результат |
| --- | --- |
| Исследование | backend был пуст; существующие backend/framework/lockfile/тесты и AGENTS.md не найдены. Android README прочитан. Git checkout отсутствует, `git status` не применим |
| `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --cache .npm` | Успешно: npm lockfile v3, без node_modules и lifecycle-скриптов |
| `npm run check` | Успешно: `node --check` 6 серверных JS-файлов и генератора JSON; ни один модуль приложения не выполнялся |
| package.json / package-lock.json | Статически сверены версия pg, engines, корневая запись lockfile, resolved URL и integrity всех зафиксированных пакетов |
| `requests/story.json` | JSON прочитан как данные; единственный content, 539 Unicode code points — в допустимом диапазоне |
| SQL-файл | Статическое чтение и проверка формы: один CREATE TABLE IF NOT EXISTS, один явный столбец content TEXT NOT NULL, без seed/ID/ключей/служебных таблиц |
| HTTP и SQL review | Три метода, GET без записи, параметризованные INSERT/DELETE, rowCount, общее trimming/code-point правило, NUL/Unicode/размер/формат, auth до тела DELETE, статические ошибки и логи |
| Dockerfile / Compose review | Сверены точные образы, npm ci, права /app и USER node, CMD напрямую Node, имя postgres в сети, отсутствие host-порта БД, 3010 по умолчанию, volume PostgreSQL 18, read-only init SQL, TCP healthcheck и service_healthy, сроки остановки |
| Ignore/config review | Реальной .env и node_modules нет. `.gitignore` исключает секреты, зависимости и сгенерированные запросы; `.dockerignore` разрешает только package-файлы и src |
| Версии и настройки образов | Сверены официальные Node.js LTS release / Docker tags, поддержка PostgreSQL 18, путь volume и параметры логирования; ссылки в README |

Имеющийся Node.js — 22.22.2, npm — 10.9.7. В Dockerfile выбран Node.js 24.22.2 LTS; Docker build не выполнялся. Lockfile создан существующим npm; `npm ci` в образе предстоит проверить пользователю.

Не применимо: существующие lint/formatter/type-checker/test-команды отсутствовали; отдельная инфраструктура для них не добавлялась. `npm run check` — проверка синтаксиса, не функциональный тест и не проверка PostgreSQL.

Не выполнено: Docker Compose config/build, фактический pull образов, выполнение DDL, HTTP-контракт на PostgreSQL, volume persistence, остановка по сигналам и обработка недоступной БД. Docker CLI и отдельный YAML/SQL-linter для проверки не использовались и не устанавливались; Compose/SQL проверены чтением, а не выполнением в целевой среде.

Готовые, но **не выполненные** команды и сценарии находятся в README и requests.http. Генератор requests/generate-cases.js тоже не запускался. Он только готовит локальные JSON-файлы для ручной проверки 299/300/10 000/10 001, emoji и escaped Unicode, пробелов/абзацев, NUL, неверного JSON/типа/полей и превышения размера.

Изменения ограничены `backend/`. Android-код, Gradle, Room, мобильные ресурсы, корневой README и настройки хостинга не изменены. Сервис не объявляется развёрнутым или протестированным с PostgreSQL. Для запуска пользователю нужны собственные .env-секреты и существующее Docker-окружение; для безопасного внешнего DELETE — последующая настройка HTTPS либо доверенный туннель.
