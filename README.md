# Dominify Trade

B2B-маркетплейс заявок для полиграфии и наружной рекламы в Узбекистане. Покупатель пишет заявку обычными словами в Telegram, ИИ разбирает её, система рассылает волнами лучшим поставщикам рядом, поставщики откликаются ценой и сроком, рейтинг строится только на подтверждённых сделках.

Архитектура описана в документе «Dominify Trade — архитектура Mini App». Этот репозиторий — её реализация.

## Что внутри

```
apps/
  server/     NestJS: один код, три процесса — api, bot (grammY), worker (BullMQ)
  miniapp/    Telegram Mini App на React + Vite
  admin/      Админка для команды на React + Vite
packages/
  shared/     Общие zod-схемы, статусы, тарифы, скоринг, транслитерация
  db/         Схема Drizzle, миграции, каталог категорий на трёх языках
infra/        Dockerfile-ы, Caddyfile, конфиги Railway для каждого сервиса
scripts/      Сквозной тест на чистой базе
```

| Процесс | Что делает |
| --- | --- |
| `api` | REST `/v1`, WebSocket `/ws`, админ-API `/admin`, вебхуки Payme и Click, страница счёта `/pay/:token` |
| `bot` | Вход, подтверждение телефона, заявки текстом, фото и голосом прямо в чате, кнопка «Отправить» |
| `worker` | ИИ-разбор, рассылка волнами, уведомления с тихими часами, сводки откликов, напоминания, подписки |
| `miniapp` | Экраны покупателя и поставщика, чат, сделки, отзывы, онбординг, тариф |
| `admin` | Метрики, модерация, ручная рассылка, компании, проверка ИНН, счета, команда |

## Локальный запуск

Нужны Node 22, pnpm 10, Postgres 16 и Redis 7 (проще всего — `docker compose up -d postgres redis`).

```bash
pnpm install
cp .env.example .env            # вписать BOT_TOKEN тестового бота и ENCRYPTION_KEY
pnpm --filter @dominify/shared build && pnpm --filter @dominify/db build
pnpm db:migrate && pnpm db:seed

pnpm dev:api        # http://localhost:3000
pnpm dev:worker
pnpm dev:bot        # long polling, вебхук не нужен
pnpm dev:miniapp    # http://localhost:5173/?dev=<любой telegram id>
pnpm dev:admin      # http://localhost:5174, dev-вход по ID из ADMIN_TELEGRAM_IDS
```

`?dev=<id>` работает только при `DEV_AUTH=1` и не в production. Чтобы открыть Mini App внутри настоящего Telegram, нужен HTTPS: пробросьте порт 5173 туннелем (например, cloudflared) и укажите этот адрес в BotFather и в `MINIAPP_URL`.

Без ключа ИИ (`LLM_PROVIDER=rules`) заявки разбираются по ключевым словам каталога: этого хватает для разработки и консьерж-режима.

## Проверки

```bash
pnpm -r typecheck
pnpm test                    # юнит-тесты: initData, JWT, шифрование, разбор, скоринг, волны, Click, тихие часы
./scripts/e2e-local.sh       # сквозной сценарий на чистой базе, 59 проверок
```

Сквозной сценарий поднимает api и воркер и проходит весь путь: вход по подписанной initData → 7 поставщиков → оплата тарифов через Payme, Click и перевод → заявка → разбор → волна 1 и волна 2 → отклики → выбор исполнителя → чат → подтверждение → отзыв → рейтинг → метрики админки. Проверяются и запреты: поддельная initData, чужая заявка, чужой чат, дубль ИНН, отзыв до закрытия сделки.

## Деплой на Railway

### 1. Telegram

1. В @BotFather создайте бота (`/newbot`) и отдельного бота для staging.
2. `/newapp` — Mini App с коротким именем `app` и адресом `https://app.dominify.app`.
3. `/setdomain` — домен `admin.dominify.app` для входа в админку через Telegram Login Widget.

Меню бота и команды бот настраивает сам при запуске.

### 2. Проект Railway

1. Тариф Pro (нужен, чтобы добавить разработчиков). В настройках аккаунта регион по умолчанию — **EU West (Amsterdam)**.
2. Новый проект из этого GitHub-репозитория. Добавьте **Postgres** и **Redis** из шаблонов и **Storage bucket**.
3. Создайте пять сервисов из репозитория и в настройках каждого укажите *Config file path*:

| Сервис | Config file path | Домен | Доп. переменные |
| --- | --- | --- | --- |
| api | `infra/railway/api.json` | api.dominify.app | — |
| bot | `infra/railway/bot.json` | bot.dominify.app | `BOT_MODE=webhook`, `BOT_PUBLIC_URL=https://bot.dominify.app`, `BOT_WEBHOOK_SECRET` |
| worker | `infra/railway/worker.json` | нет | — |
| miniapp | `infra/railway/miniapp.json` | app.dominify.app | `APP=miniapp`, `VITE_API_URL=https://api.dominify.app` |
| admin | `infra/railway/admin.json` | admin.dominify.app | `APP=admin`, `VITE_API_URL=https://api.dominify.app`, `VITE_BOT_USERNAME` |

Миграции и каталог применяются pre-deploy командой сервиса `api`, отдельно их запускать не нужно.

### 3. Общие переменные (Shared Variables проекта)

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
PUBLIC_API_URL=https://api.dominify.app
MINIAPP_URL=https://app.dominify.app
ADMIN_URL=https://admin.dominify.app
BOT_TOKEN=...
BOT_USERNAME=...
JWT_SECRET=...            # 32+ случайных символа
ENCRYPTION_KEY=...        # 32 байта в base64; храните копию в надёжном месте
HASH_KEY=...
ADMIN_TELEGRAM_IDS=...    # ваш Telegram ID
NOTIFY_DRIVER=telegram
LLM_PROVIDER=gemini          # или anthropic
GEMINI_API_KEY=...           # ключ из Google AI Studio
ANTHROPIC_API_KEY=...        # если выбран anthropic
STORAGE_DRIVER=s3
S3_ENDPOINT=${{Bucket.ENDPOINT}}
S3_BUCKET=${{Bucket.BUCKET}}
S3_REGION=${{Bucket.REGION}}
S3_ACCESS_KEY_ID=${{Bucket.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{Bucket.SECRET_ACCESS_KEY}}
```

В окружении `staging` — токен тестового бота, `NOTIFY_DRIVER=telegram` и песочницы платёжек.

### 4. Домены

В DNS dominify.app добавьте CNAME-записи на адреса, которые Railway покажет для каждого сервиса.

### 5. Оплата счетов

Подписки поставщиков не продаются внутри Mini App: по правилам Telegram цифровые услуги там оплачиваются только в Stars. Менеджер выставляет счёт в админке, клиент платит по ссылке `https://api.dominify.app/pay/<token>` картой (Payme, Click) или переводом по реквизитам.

| Платёжка | Адрес для кабинета мерчанта | Переменные |
| --- | --- | --- |
| Payme (Merchant API) | `https://api.dominify.app/webhooks/payme`, реквизит `invoice_id` | `PAYME_MERCHANT_ID`, `PAYME_KEY`, `PAYME_IKPU_CODE`, `PAYME_PACKAGE_CODE` |
| Click (SHOP API) | Prepare `…/webhooks/click/prepare`, Complete `…/webhooks/click/complete` | `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY` |
| Перевод | реквизиты на странице счёта, отметка «Оплачен» в админке | `BANK_REQUISITES` |

## Решения, которые стоит знать

- **Похожие заявки ищутся через pg_trgm**, а не pgvector: он есть в стандартном Postgres на Railway. Переход на эмбеддинги — отдельная миграция, когда понадобится.
- **Разбор ИИ** идёт через Gemini (строгая JSON-схема ответа) или Claude (принудительный вызов инструмента), провайдер выбирается переменной `LLM_PROVIDER`. В обоих случаях ответ проверяется zod, а промпт общий. Claude — с принудительным вызовом инструмента и проверкой ответа zod. Сначала быстрая модель, при низкой уверенности или фото — сильная. При сбое провайдера заявка разбирается правилами, а не теряется. Телефоны и ИНН маскируются до отправки.
- **Уведомления** уходят только тем, кто разрешил боту писать (нажал «Старт» или дал разрешение в Mini App). Несрочные ждут конца тихих часов 22:00–8:00 по Ташкенту.
- **Поставщик видит заявку**, только если она ему разослана; бесплатный тариф видит её через 15 минут. Контакты покупателя открываются только выбранному исполнителю.
- **Телефон и ИНН** шифруются AES-256-GCM, для поиска дублей хранится HMAC. Просмотр этих данных в админке пишется в журнал.

## До запуска с реальными клиентами

- [ ] Юрист: основание для хранения данных за рубежом по ст. 27-1 (ЗРУ-1125), политика конфиденциальности, экран тарифа в Mini App.
- [ ] Провайдер распознавания речи: сравнить 2–3 на 50 реальных голосовых.
- [ ] Эталонный набор из 200 реальных заявок для проверки качества разбора.
- [ ] Реквизиты, ИКПУ и договоры с Payme и Click.
