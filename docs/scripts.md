# Скрипты проекта

Все диагностические/настроечные node-cli живут в `proxy-feed/scripts/`. Запускать из корня репозитория или из `proxy-feed/` — путь к фиду подстроен под обе локации.

## Фид

### `build-feed.mjs`
Главный билдер фида. Тянет YML Domoplaner, фильтрует мёртвые URL (под партнёрским логином), переписывает `<rooms>`/`<floor>` из портального title, добавляет реальный номер квартиры (`кв. №N`) в fact-prefix, вшивает `URL этого лота: …` в description, обогащает синонимами по комнатам/ЖК/отделке, добавляет price-band и planning-image. Запуск через GitHub Actions cron каждые 6 часов.

Локальный прогон с проверкой URL:
```bash
cd proxy-feed
BOOKING_FIZIKA_LOGIN=+79626921717 BOOKING_FIZIKA_PASSWORD=3141 node scripts/build-feed.mjs
```

### `verify-feed-vs-portal.mjs`
Сверяет каждый `<offer>` в `public/feed.xml` с реальной страницей на портале (под партнёрским логином). Проверяет area / price / rooms / floor / complex. Текущий бейзлайн — 253/253.

```bash
BOOKING_FIZIKA_LOGIN=… BOOKING_FIZIKA_PASSWORD=… node scripts/verify-feed-vs-portal.mjs
```

## История чатов Flynn

### `flynn-export-messages.mjs`
Дамп истории сообщений из таблицы `messages` через PostgREST. Сохраняет JSON.

```bash
FLYNN_TOKEN=… node proxy-feed/scripts/flynn-export-messages.mjs
```

### `flynn-audit-messages.mjs`
Базовая категоризация ошибок по эвристикам (fallback / vague / no-url / quoted-template / manager-escalation).

```bash
FLYNN_TOKEN=… node proxy-feed/scripts/flynn-audit-messages.mjs
```

### `flynn-full-audit.mjs`
Расширенный аудит. Кросс-проверяет утверждения бота против локального `public/feed.xml`:
- URL_DESC_MISMATCH (URL ведёт на другую квартиру)
- URL_NOT_IN_FEED (выдал галлюцинированный URL)
- FALSE_NEGATIVE (сказал «нет», хотя в фиде N подходящих)
- FALLBACK / QUOTED_TPL / META_QUESTION / TOO_SHORT

Сохраняет в `full-audit-failures.json`.

```bash
FLYNN_TOKEN=… LIMIT=500 node proxy-feed/scripts/flynn-full-audit.mjs
```

### `flynn-verify-bot-citations.mjs`
Для каждой пары «описание лота / URL» из ответов бота проверяет, что URL ведёт на квартиру с такими же параметрами. Тянет страницу портала под логином, сравнивает area / price / rooms / floor / complex.

```bash
FLYNN_TOKEN=… BOOKING_FIZIKA_LOGIN=… BOOKING_FIZIKA_PASSWORD=… SINCE=2026-05-24T10:33:00 node proxy-feed/scripts/flynn-verify-bot-citations.mjs
```

## Регрессионные тесты

### `flynn-regression-test.mjs`
Старая регрессия — 10 жёстких assertion на конкретных фразах. Использовать как smoke-test, не как доказательство стабильности.

### `flynn-regression-structural.mjs`
Структурная регрессия — 18 тестов, 6 классов × 3 лексических варианта. Проверяет структурные свойства ответа (есть URL / нет fallback / правильный тип URL), а не точные строки. Использует cache-bust (вариация trailing punctuation) для обхода ответного кеша Flynn.

### `flynn-regression-structural-v2.mjs`
Расширенная регрессия — 24 теста, 8 классов (A-J: добавлены meta-question, multi-turn, superlative), полностью **другие** формулировки/ЖК/бюджеты для проверки что промпт ловит структуру, а не запомненные кейсы. Текущий результат: 21/24.

## Детерминированный ответчик (без LLM)

### `answer-from-feed.mjs`
Простой ответчик: парсит запрос (ЖК / комнатность / бюджет / intent) → ищет в `public/feed.xml` → возвращает корректный ответ с реальными URL. Без LLM. На 10 исторически провальных запросах Flynn — даёт 10/10 корректных ответов.

Используется как:
- Доказательство, что фид содержит все данные (Flynn галлюцинирует не из-за данных)
- Основа для будущего backend-proxy (если уйдём от Flynn)

```bash
cd proxy-feed
node answer-from-feed.mjs
```

## Получение токенов

### Flynn (PostgREST)

В браузере открой https://flynn-ai.ru/dashboard под логином клиента → DevTools console:
```js
JSON.parse(localStorage['sb-flynn-ai-auth-token']).access_token
```

Переменная окружения: `FLYNN_TOKEN=<jwt>`

### Booking.fizika.group (партнёрский портал)

Креды партнёра: `BOOKING_FIZIKA_LOGIN=+79626921717`, `BOOKING_FIZIKA_PASSWORD=3141`.

### Supabase anon apikey

Постоянный для всех проектов Flynn, вшит в скрипты. Подсмотреть в любом fetch к `flynn-ai.ru/rest/v1/*` в Network-вкладке.

## Типичные сценарии

**Изменили промпт через PostgREST → проверить эффект:**
1. В кабинете Flynn → Обучение ИИ → База знаний → Очистить кеш
2. `node proxy-feed/scripts/flynn-regression-structural-v2.mjs` — посмотреть изменение
3. После 1-2 дней живого использования: `node proxy-feed/scripts/flynn-full-audit.mjs`

**Клиент пожаловался на конкретный плохой ответ:**
1. В кабинете Flynn → Сообщения → найти время + visitor_id
2. `SINCE=<timestamp> LIMIT=10 node proxy-feed/scripts/flynn-verify-bot-citations.mjs` — посмотреть mismatch
3. Сверить с `answer-from-feed.mjs` — был бы детерминированный ответ корректным

**Изменили build-feed → проверить публикацию:**
1. `git push origin main` — workflow триггерится автоматически
2. `gh run watch <id>` — ждать завершения
3. Проверить URL: `curl -s https://stepanenkoviktor0110-boop.github.io/fizika-b24u-bot-setup/feed.xml | head -200`
