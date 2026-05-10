# fizika-b24u-bot-setup

Domoplaner YML feed proxy for the [B24U](https://b24u.ru) AI assistant on
[booking.fizika.group](https://booking.fizika.group).

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
