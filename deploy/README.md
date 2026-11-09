# Применение на Ubuntu оператором

Эти действия подготовлены, но **не выполнены Codex**. SSH-доступ, установленная версия Ollama, действующий конфиг/его symlink-target, процессы и порт 3012 не проверялись. Не заменяйте Productivum на 3011 и не устанавливайте модель/драйверы ради этой интеграции.

1. Проверьте `ss -ltnp` для 3010/3011/3012/11434, `readlink -f /etc/nginx/sites-enabled/api.productivumtesting.ru`, текущие units/процессы и `nginx -T` локально на сервере. Не публикуйте вывод конфигов с секретами. Если 3012 занят — никого не останавливайте: выберите свободный loopback-порт, измените AI_PORT и только upstream AI-сниппета. Код запрещает занимать 3010/3011/11434.
2. Разместите **этот backend** в `/opt/iskrenne-backend`, сохраните предыдущую версию для отката. Используйте уже установленную Node LTS и проверьте реальный путь `command -v node`; при отличии от `/usr/bin/node` поправьте два unit. Зависимости: `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`. Не меняйте процесс/каталог Productivum.
3. Подготовьте отдельного непривилегированного пользователя `iskrenne-ai` либо замените User/Group в обоих units существующей сервисной учётной записью. Код и node_modules доступны ему только для чтения. Секреты храните в `/etc/iskrenne-ai.env`, root:root 0600; systemd читает EnvironmentFile до перехода к User. `.env.example` содержит необходимые поля. Используйте существующие PG_* и независимо сгенерированный AI_SERVICE_KEY; не переносите секреты через чат/Git. PostgreSQL должен быть доступен процессу по существующей приватной сети, без нового публичного порта.
4. Сделайте резервную копию существующей БД обычным принятым способом. Перед первым запуском выполните под учётной записью миграции с защищённым env: `node --env-file=/путь/к/защищённому/env src/ai/cli.js migrate`. Миграция `002-ai.sql` добавляет schema ai и не меняет public.stories. Вариант для уже действующего Compose, без публикации порта БД:

```bash
# Из каталога действующего Compose; файл SQL из новой версии backend.
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < sql/002-ai.sql
```

Это ручное применение к **существующему** сервису, не запуск новых контейнеров. Для нового пустого volume первоначальная `001-stories.sql` остаётся прежней; `002-ai.sql` всё равно применяйте явно. Не удаляйте volume и не пересоздавайте БД.

5. Проверьте метаданные Ollama командой `node --env-file=... src/ai/cli.js inspect-ollama`. Если версия/модель/think=false несовместимы, остановитесь и согласуйте версию; не скачивайте замену и не включайте облачный fallback. Скопируйте подготовленные units в `/etc/systemd/system/`, затем после проверки путей и окружения:

```bash
sudo systemd-analyze verify /etc/systemd/system/iskrenne-ai.service /etc/systemd/system/iskrenne-ai-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now iskrenne-ai.service iskrenne-ai-worker.service
sudo systemctl status iskrenne-ai.service iskrenne-ai-worker.service
sudo journalctl -u iskrenne-ai.service -u iskrenne-ai-worker.service -n 100 --no-pager
```

6. Выполните localhost curl из `../AI.md`: без/с неверным ключом 401, GET empty, POST JSON → 202, status → succeeded, GET готового отчёта, повтор POST → 200; затем один короткий chat. Это ограниченный smoke test, не нагрузка. Подождите с cold start несколько минут. По завершении проверяйте реальное done и корректный usage, не ожидайте размещения всей модели в VRAM. Не подвергайте действующие данные тестовым массовым изменениям.
7. Только затем вставьте `nginx-ai.conf` внутрь **реального существующего TLS server**, не подменяя файл целиком. `/` и его upstream `127.0.0.1:3011`, SSL, Certbot, Nextcloud и другие vhosts сохраняются. Перед редактированием сделайте копию symlink-target **вне sites-enabled/conf.d**:

```bash
target=$(readlink -f /etc/nginx/sites-enabled/api.productivumtesting.ru)
test -n "$target" && sudo test -f "$target"
sudo install -d -m 700 /var/backups/iskrenne-ai-nginx
backup="/var/backups/iskrenne-ai-nginx/api.$(date -u +%Y%m%dT%H%M%SZ).conf"
sudo cp --preserve=all -- "$target" "$backup"
# Отредактируйте проверенный "$target", вставив location из nginx-ai.conf.
sudo nginx -t
# ТОЛЬКО при успехе предыдущей проверки:
sudo systemctl reload nginx
```

Путь назначения проверки не вычисляется из пользовательского ввода. Если readlink/test завершается ошибкой, дальше не продолжайте. При неуспешном `nginx -t` восстановите `sudo cp --preserve=all -- "$backup" "$target"`, снова `sudo nginx -t`; reload допускается только после успеха. Nginx не останавливайте.

8. Выполните те же curl на `https://api.productivumtesting.ru` и проверьте отсутствие регрессии прежнего API на 3011. Префикс `/ai/` сохраняется благодаря proxy_pass **без завершающего слеша**. Тайм-аут 2000 секунд рассчитан на стандартные лимиты. При изменении env согласуйте: queueWait + maxAttempts*(loadTimeout + generationTimeout) + запас; TimeoutStopSec worker тоже должен позволять закончить текущий запрос. Не меняйте тайм-ауты остальных маршрутов.

## Откат

Восстановите сохранённый реальный Nginx-конфиг, выполните `nginx -t` и только затем reload. Остановите/отключите **только** iskrenne-ai и iskrenne-ai-worker; они завершают активную работу корректно. Возвратите сохранённую версию backend при необходимости. public.stories и Productivum не затрагиваются. AI-схему и volume при обычном откате не удаляйте — сохранённые отчёты и барьер восстановления могут понадобиться. При принудительном убийстве worker см. confirmed-idle восстановление в AI.md; не запускайте параллельную генерацию вслепую.
