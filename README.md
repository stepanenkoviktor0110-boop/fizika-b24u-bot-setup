# fizika-flynn-bot-setup

YML feed proxy + Flynn-AI chatbot setup для [booking.fizika.group](https://booking.fizika.group).
Изначально настраивался под B24U, с 2026-05 мигрирован на Flynn-AI.

## Структура

| Путь | Что |
|---|---|
| `proxy-feed/scripts/build-feed.mjs` | Главный билдер YML-фида |
| `proxy-feed/scripts/*.mjs` | Аудит, регрессии, верификация (см. `docs/scripts.md`) |
| `proxy-feed/answer-from-feed.mjs` | Детерминированный ответчик по фиду (без LLM) |
| `.github/workflows/build-feed.yml` | Cron каждые 6 часов → публикация в `gh-pages` |
| `docs/rag-bot-setup-principles.md` | Универсальные принципы настройки RAG-чатбота |
| `docs/flynn-bot-repair-prompt.md` | Self-contained инструкция для починки Flynn-бота другого клиента |
| `docs/scripts.md` | Описание всех диагностических скриптов |
| `clients/fizika/baseline-2026-05-24.md` | **Финальный snapshot Fizika** |
| `clients/fizika/findings-llm-hallucination-2026-05-24.md` | Главная находка: Flynn-LLM галлюцинирует |
| `clients/fizika/flynn-prompt-patterns.md` | Промпт-паттерны для Fizika |
| `clients/fizika/flynn-dashboard-checklist.md` | Чек-лист действий в кабинете Flynn |
| `clients/fizika/snapshots/*` | Snapshots до каждой деструктивной правки |

## Быстрый старт

- Текущее состояние клиента → `clients/fizika/baseline-2026-05-24.md`
- Для нового клиента → `docs/rag-bot-setup-principles.md`
- Починка Flynn-бота другого клиента → `docs/flynn-bot-repair-prompt.md`

---

## Legacy: feed-proxy для B24U (изначальная задача)

Описание оставлено для исторического контекста — Flynn-runtime использует тот же фид без изменений.

## What this does

B24U pulls a product feed for its chat-widget carousel. The upstream Domoplaner
feed has two issues:

1. **Sold flats stay `available='true'`.** The bot recommends apartments that
   are no longer for sale.
2. **`<rooms>` carries marketing labels** (`студия`, `пентхаус`) instead of
   numbers.

This proxy:

- Logs in to `booking.fizika.group` with partner credentials and drops offers
  whose listing page no longer renders.
- Parses the booking page `<title>` and overrides `<rooms>` with the real
  number from the listing (the booking page is the source of truth).
- Enriches `<description>` with room/complex synonyms, corpus/section, price
  and renovation in natural language so semantic search ranks the apartment
  cards above long PDF chunks.
- Rebuilds every 6 hours and publishes the result to the `gh-pages` branch.

## Files

- `proxy-feed/scripts/build-feed.mjs` — feed builder.
- `proxy-feed/README.md` — local development.
- `.github/workflows/build-feed.yml` — scheduled cron + auto-publish to
  `gh-pages`.

## Required GitHub secrets

- `BOOKING_FIZIKA_LOGIN` — partner phone number.
- `BOOKING_FIZIKA_PASSWORD` — partner password.

Without these, the URL liveness check and title-based room normalization are
skipped (a warning is logged); the build still succeeds.

## Output

After the workflow runs, the feed is available at the GitHub Pages URL of this
repository (`/feed.xml`). That URL is what gets configured in the B24U partner
console under «База знаний → Фиды товаров».
