import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Domoplaner feed URL carries a per-partner access token and is rotated by the
// provider — keep it in the FEED_SOURCE_URL secret/env, never hardcoded here
// (this repo is public). Missing config fails loudly in loadFeed().
const SOURCE_URL = process.env.FEED_SOURCE_URL ?? null;
const LOCAL_PATH = resolve(__dirname, '../../old/artifacts/domoplaner-feed-original-2026-05-09.yml');
const OUTPUT_PATH = resolve(__dirname, '../../public/feed.xml');

const ROOM_SYNONYMS = {
  0: 'студия, квартира-студия, студийная квартира, студии',
  1: '1-комнатная, однокомнатная, однушка, 1к, 1-комн, 1-к',
  2: '2-комнатная, двухкомнатная, двушка, 2к, 2-комн, 2-к',
  3: '3-комнатная, трёхкомнатная, трехкомнатная, трёшка, трешка, 3к, 3-комн, 3-к',
  4: '4-комнатная, четырёхкомнатная, четырехкомнатная, четырёшка, четырешка, 4к, 4-комн, 4-к',
};

const PENTHOUSE_SYNONYMS = 'пентхаус, penthouse, премиальные апартаменты';

const COMPLEX_SYNONYMS = {
  'Talento': 'Talento, Таленто, ЖК Talento, ЖК Таленто',
  'VIDI': 'VIDI, Vidi, Види, ВиДи, ЖК VIDI, ЖК Види',
  'Остров Первых': 'Остров Первых, Остров, Матисов остров, ЖК Остров, ЖК Остров Первых',
  'Моисеенко 10': 'Моисеенко 10, Моисеенко, ул. Моисеенко 10, улица Моисеенко 10, ЖК Моисеенко',
};

// Section → corpus mapping per complex (verified from B24U RAG entry "Структура корпусов и секций по ЖК Fizika").
// Talento: 1 corpus, 2 sections → corpus is always 1.
// Моисеенко 10: section 1=corpus 1, sections 2/3=corpus 2, section 4=corpus 3, section 5=corpus 4.
// Остров Первых: building-section comes as "N корпус M секция" — corpus+section together in one field.
// VIDI: structure not loaded → corpus is not derived.
const MOISEENKO_SECTION_TO_CORPUS = { 1: 1, 2: 2, 3: 2, 4: 3, 5: 4 };

function ostrovParts(section) {
  if (!section) return null;
  const m = String(section).match(/(\d+)\s*корпус\s*(\d+)\s*секция/i);
  if (!m) return null;
  return { corpus: parseInt(m[1], 10), section: parseInt(m[2], 10) };
}

function buildingLabel(buildingName, section) {
  if (!buildingName) return { corpus: null, section: null };
  const name = String(buildingName).toLowerCase();

  if (name.includes('talento')) {
    const sectionNum = section ? String(section).match(/\d+/)?.[0] : null;
    return {
      corpus: 'корпус 1, К1',
      section: sectionNum ? `секция ${sectionNum}, с.${sectionNum}` : null,
    };
  }

  if (name.includes('моисеенко')) {
    const sectionNum = section ? parseInt(String(section).match(/\d+/)?.[0], 10) : null;
    const corpusNum = sectionNum && MOISEENKO_SECTION_TO_CORPUS[sectionNum];
    return {
      corpus: corpusNum ? `корпус ${corpusNum}, К${corpusNum}, ${corpusNum}-я очередь` : null,
      section: sectionNum ? `секция ${sectionNum}, с.${sectionNum}` : null,
    };
  }

  if (name.includes('остров')) {
    const parts = ostrovParts(section);
    if (!parts) return { corpus: null, section: null };
    const { corpus, section: sec } = parts;
    return {
      corpus: `корпус ${corpus}, К${corpus}, ${corpus}-я очередь`,
      section: `секция ${sec}, с.${sec}`,
    };
  }

  return { corpus: null, section: null };
}

const RENOVATION_LABELS = {
  'черновая': 'черновая отделка, без отделки, white box',
  'предчистовая': 'предчистовая отделка, white box',
  'чистовая': 'чистовая отделка, с отделкой, под ключ',
  'с отделкой': 'с отделкой, чистовая отделка, под ключ',
};

function priceProse(price) {
  if (!price) return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  const mln = (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '');
  return `цена ${mln} млн рублей, ${n.toLocaleString('ru-RU')} ₽`;
}

// Flynn retrieval is lexical — it does not parse "до 40 млн" as price≤40000000.
// To make budget-bounded queries hit the right offers, we embed the textual price
// bands ("до 35 млн", "до 40 млн", "до 50 млн") into description. Each offer gets
// the next 3 round thresholds from a fixed grid, so "двушки Talento до 40 млн"
// matches a 33.26 млн offer via the literal "до 40 млн" token.
const PRICE_THRESHOLDS_MLN = [15, 20, 25, 30, 35, 40, 50, 60, 75, 90, 100, 110];
function priceBandSynonyms(price) {
  if (!price) return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  const mln = n / 1_000_000;
  const bands = PRICE_THRESHOLDS_MLN.filter(t => t >= mln).slice(0, 3);
  if (!bands.length) return null;
  return `бюджет: ${bands.map(b => `до ${b} млн`).join(', ')}`;
}

function areaFromName(name) {
  if (!name) return null;
  const m = String(name).match(/(\d+(?:[.,]\d+)?)\s*м²/);
  if (!m) return null;
  const v = m[1].replace(',', '.');
  // Agents query in rounded m² ("двушка 77 м² 7 этаж"), source feed carries
  // precise decimals ("77.44 м²"). Append rounded value so semantic retrieval
  // matches whole-number queries against per-flat cards instead of bouncing
  // them up to long manual descriptions.
  const rounded = Math.round(parseFloat(v));
  const roundedLabel = Number.isFinite(rounded) && String(rounded) !== v ? `, ${rounded} м²` : '';
  return `площадь ${v} квадратных метров, ${v} м²${roundedLabel}`;
}

function roomsLabel(rooms, name) {
  const n = parseInt(rooms, 10);
  if (!Number.isNaN(n) && ROOM_SYNONYMS[n]) return ROOM_SYNONYMS[n];
  if (n >= 5) return PENTHOUSE_SYNONYMS;
  // fallback by name
  if (name && /студи/i.test(name)) return ROOM_SYNONYMS[0];
  if (name && /пентхаус|penthouse/i.test(name)) return PENTHOUSE_SYNONYMS;
  return null;
}

function complexLabel(buildingName) {
  if (!buildingName) return null;
  const key = Object.keys(COMPLEX_SYNONYMS).find(k =>
    buildingName.toLowerCase().includes(k.toLowerCase())
  );
  return key ? COMPLEX_SYNONYMS[key] : `ЖК ${buildingName}`;
}

function renovationLabel(renovation) {
  if (!renovation) return null;
  const key = Object.keys(RENOVATION_LABELS).find(k =>
    String(renovation).toLowerCase().includes(k)
  );
  return key ? RENOVATION_LABELS[key] : `отделка: ${renovation}`;
}

// Canonical fact-prefix concentrates top-discriminating tokens (ЖК, rooms label,
// price, area, floor, offer id) in the first ~120 chars of <description>. BM25
// length normalization gives early tokens disproportionate weight, and Flynn's
// retrieval is lexical — so a dense prefix beats the same tokens spread across
// the body. Format: `Talento • Двухкомнатная (двушка) • 33.26 млн ₽ • 72.47 м² • эт.3 • № 318152.`
function shortRoomsTag(rooms, name) {
  const n = parseInt(rooms, 10);
  const map = { 0: 'Студия', 1: 'Однокомнатная (однушка)', 2: 'Двухкомнатная (двушка)', 3: 'Трёхкомнатная (трёшка)', 4: 'Четырёхкомнатная' };
  if (!Number.isNaN(n) && map[n]) return map[n];
  if (n >= 5) return 'Пентхаус';
  if (name && /студи/i.test(name)) return 'Студия';
  if (name && /пентхаус|penthouse/i.test(name)) return 'Пентхаус';
  return null;
}
function shortComplexTag(buildingName) {
  if (!buildingName) return null;
  const n = String(buildingName).toLowerCase();
  if (n.includes('talento')) return 'Talento';
  if (n.includes('vidi')) return 'VIDI';
  if (n.includes('остров')) return 'Остров Первых';
  if (n.includes('моисеенко')) return 'Моисеенко 10';
  return buildingName;
}
function shortPriceTag(price) {
  if (!price) return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  const mln = (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '');
  return `${mln} млн ₽`;
}
function shortAreaTag(name) {
  if (!name) return null;
  const m = String(name).match(/(\d+(?:[.,]\d+)?)\s*м²/);
  if (!m) return null;
  return `${m[1].replace(',', '.')} м²`;
}
function buildFactPrefix(offer) {
  // Apartment number: prefer real portal number (e.g. №29 from title), fall back
  // to CRM offer id only when title parse failed (no liveness check / dead page).
  // Agents search/cite by portal number, not by CRM id — see snapshot 2026-05-24.
  const aptNum = offer.__apt_number;
  const idLabel = aptNum ? `кв. №${aptNum}` : (offer['@_id'] ? `арт. ${offer['@_id']}` : null);
  const facts = [
    shortComplexTag(offer['building-name']),
    shortRoomsTag(offer.rooms, offer.name),
    shortPriceTag(offer.price),
    shortAreaTag(offer.name),
    offer.floor ? `эт.${offer.floor}` : null,
    idLabel,
  ].filter(Boolean);
  return facts.length ? facts.join(' • ') : null;
}

function buildEnrichedDescription(offer) {
  const parts = [];

  const factPrefix = buildFactPrefix(offer);
  if (factPrefix) parts.push(factPrefix);

  // Anchor the listing URL inside the description so the LLM cannot pair
  // a description from one offer with a URL from another (verified failure
  // mode 2026-05-24: bot said "Talento, №29, 33.3 млн" but URL pointed to
  // /flat/4291/ which is actually "Остров №131, 37.7 млн"). When URL lives
  // only in <url> field, RAG returns description and URL as separate tokens
  // and the model picks them independently. Embedding URL into the same
  // text block forces them to travel together.
  if (offer.url) parts.push(`URL этого лота: ${offer.url}`);

  const rooms = roomsLabel(offer.rooms, offer.name);
  const complex = complexLabel(offer['building-name']);
  if (rooms && complex) {
    parts.push(`${rooms} в ${complex}`);
  } else if (rooms) {
    parts.push(rooms);
  } else if (complex) {
    parts.push(complex);
  }

  const { corpus, section: sectionLabel } = buildingLabel(offer['building-name'], offer['building-section']);
  if (corpus) parts.push(corpus);
  if (sectionLabel) parts.push(sectionLabel);
  if (offer.floor) parts.push(`этаж ${offer.floor}`);

  const area = areaFromName(offer.name);
  if (area) parts.push(area);

  const price = priceProse(offer.price);
  if (price) parts.push(price);

  const priceBand = priceBandSynonyms(offer.price);
  if (priceBand) parts.push(priceBand);

  const renovation = renovationLabel(offer.renovation);
  if (renovation) parts.push(renovation);

  if (offer.adress) parts.push(`адрес: ${offer.adress}`);

  // Picture from Domoplaner is the actual floor plan of the apartment.
  // B24U RAG indexer drops <picture> tags from offers — so the bot has no way
  // to cite a real plan URL and hallucinates a fake media.p9t.ru one instead.
  // Surfacing the URL inside <description> guarantees it enters the RAG Content
  // chunk, and the model can quote it verbatim when an agent asks for the plan.
  const pictures = Array.isArray(offer.picture) ? offer.picture : (offer.picture ? [offer.picture] : []);
  const pictureUrls = pictures.map(p => typeof p === 'string' ? p.trim() : '').filter(Boolean);
  if (pictureUrls.length) {
    parts.push(`Планировка квартиры (изображение): ${pictureUrls[0]}`);
  }

  // Append original description at the end, if any
  if (offer.description) parts.push(String(offer.description).trim());

  return parts.filter(Boolean).join('. ');
}

async function loadFeed() {
  if (process.env.LOCAL === '1') {
    return await readFile(LOCAL_PATH, 'utf8');
  }
  if (!SOURCE_URL) {
    throw new Error('FEED_SOURCE_URL is not set — provide the Domoplaner feed URL via the FEED_SOURCE_URL secret/env.');
  }
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'fizika-feed-proxy/1.0' } });
  if (!res.ok) throw new Error(`Source feed fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

// Domoplaner feed advertises listing pages under /flat/ or /commerce/. When a flat is sold or hidden,
// booking.fizika.group serves HTTP 200 but redirects either to /complex/<id>/?flat=<id> (renders the
// complex landing page, not the apartment) or to /auth/ (when not the partner's listing). Such
// redirects must be filtered out.
const VALID_PATH = /^\/(flat|commerce)\//i;

async function loginToBooking() {
  const phone = process.env.BOOKING_FIZIKA_LOGIN;
  const password = process.env.BOOKING_FIZIKA_PASSWORD;
  if (!phone || !password) return null;
  const fd = new FormData();
  fd.append('phone', phone);
  fd.append('password', password);
  const res = await fetch('https://booking.fizika.group/auth/login/', { method: 'POST', body: fd, redirect: 'manual' });
  const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  const data = await res.json().catch(() => ({}));
  if (!data || data.success !== 1) return null;
  // Server may send the same cookie name twice (regenerated PHPSESSID before/after auth). Keep the last value.
  const jar = new Map();
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  return jar.size ? Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ') : null;
}

async function checkUrl(url, cookie, { timeout = 8000 } = {}) {
  if (!url) return { ok: false, reason: 'no_url' };
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'bad_url' }; }
  if (!VALID_PATH.test(parsed.pathname)) {
    return { ok: false, reason: 'bad_path' };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const headers = cookie ? { Cookie: cookie } : {};
    const res = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) {
      clearTimeout(t);
      return { ok: false, status: res.status, reason: 'http_error' };
    }
    const finalPath = new URL(res.url).pathname;
    if (!VALID_PATH.test(finalPath)) {
      clearTimeout(t);
      return { ok: false, status: res.status, reason: 'redirected_off_listing', final: res.url };
    }
    // booking.fizika.group serves /flat/<id>/ for any id (200 OK), but body is empty for non-existent
    // ids. Real listings render full HTML — flats ~60KB (with <title>), commerce/office ~37KB (without
    // <title>, but with price). Threshold of 10K reliably separates dead pages from live listings.
    const html = await res.text();
    clearTimeout(t);
    if (html.length < 10000) {
      return { ok: false, status: res.status, reason: 'empty_body', length: html.length };
    }
    return { ok: true, status: res.status, rooms_from_title: parseRoomsFromHtmlTitle(html), floor_from_page: parseFloorFromHtml(html), apt_number_from_title: parseAptNumberFromTitle(html) };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

// booking.fizika.group titles look like "N-комн. квартира, №… <ЖК>" or "Студия, №… <ЖК>".
// This is the authoritative source — Domoplaner's <rooms> sometimes ships marketing labels
// ("пентхаус") or omits the count, while the booking page always has the real number.
function parseRoomsFromHtmlTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (!m) return null;
  const title = m[1];
  const rooms = title.match(/(\d+)-комн/i);
  if (rooms) return parseInt(rooms[1], 10);
  if (/студи/i.test(title)) return 0;
  return null;
}

// Authoritative floor source: portal page reads "Этаж\nN из M" (label + value blocks).
// Domoplaner's <floor> sometimes differs by ±1 (verified 19 cases in Остров Первых
// where YML floor=2 but portal shows "Этаж 3 из 12"). Overrides take precedence.
function parseFloorFromHtml(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const m = text.match(/Этаж\s+(\d+)\s+из\s+\d+/i);
  return m ? parseInt(m[1], 10) : null;
}

// Apartment number as printed on the portal title: «Студия, №29. Talento».
// Agents search by this number (visible in floor plans / шахматка), not by the
// CRM offer id (318156). Override CRM id with apt number in the fact-prefix
// so the bot cites №29 instead of №318156.
function parseAptNumberFromTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (!m) return null;
  const num = m[1].match(/№\s*(\d+)/);
  return num ? num[1] : null;
}

async function filterAlive(offers, cookie, { concurrency = 12 } = {}) {
  const alive = [];
  const dropped = [];
  let i = 0;
  async function worker() {
    while (i < offers.length) {
      const idx = i++;
      const offer = offers[idx];
      const result = await checkUrl(offer.url, cookie);
      if (result.ok) {
        if (result.rooms_from_title != null) {
          offer.__rooms_from_title = result.rooms_from_title;
        }
        if (result.floor_from_page != null) {
          offer.__floor_from_page = result.floor_from_page;
        }
        if (result.apt_number_from_title != null) {
          offer.__apt_number = result.apt_number_from_title;
        }
        alive.push(offer);
      } else dropped.push({ id: offer['@_id'], url: offer.url, ...result });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { alive, dropped };
}

async function main() {
  const xml = await loadFeed();

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    cdataPropName: '__cdata',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    cdataPropName: '__cdata',
    format: false,
    suppressEmptyNode: true,
  });

  const data = parser.parse(xml);
  const offers = data?.yml_catalog?.shop?.offers?.offer ?? [];
  const list = Array.isArray(offers) ? offers : [offers];

  // Filter out offers whose listing URL is dead (sold flats that Domoplaner still ships with available='true').
  // booking.fizika.group requires partner auth — without it every URL redirects to /auth/. So we either
  // log in (when credentials are present) or skip the check entirely.
  const skipUrlCheck = process.env.SKIP_URL_CHECK === '1';
  let cookie = null;
  if (!skipUrlCheck) {
    cookie = await loginToBooking();
    if (!cookie) {
      console.warn('booking.fizika.group login failed or credentials missing — skipping URL liveness check');
    }
  }
  const { alive, dropped } = (skipUrlCheck || !cookie)
    ? { alive: list, dropped: [] }
    : await filterAlive(list, cookie);

  let enrichedCount = 0;
  let roomsNormalized = 0;
  let roomsOverriddenFromTitle = 0;
  let floorOverriddenFromPage = 0;
  const roomsMismatches = [];
  const floorMismatches = [];
  for (const offer of alive) {
    // Source of truth for room count: <title> on the booking.fizika.group listing page,
    // collected during URL liveness check. Domoplaner ships marketing labels
    // ("пентхаус") and inconsistent values. When title-derived count is available,
    // it overrides whatever Domoplaner sent. Falls back to text normalization
    // (студия → 0) when URL check was skipped (no creds / SKIP_URL_CHECK=1).
    const titleRooms = offer.__rooms_from_title;
    if (titleRooms != null) {
      const ymlRooms = String(offer.rooms ?? '');
      const titleStr = String(titleRooms);
      if (ymlRooms !== titleStr) {
        if (roomsMismatches.length < 5) {
          roomsMismatches.push({ id: offer['@_id'], url: offer.url, yml: ymlRooms, title: titleStr });
        }
        offer.rooms = titleStr;
        roomsOverriddenFromTitle++;
      }
      delete offer.__rooms_from_title;
    } else if (typeof offer.rooms === 'string' && /студи/i.test(offer.rooms)) {
      offer.rooms = '0';
      roomsNormalized++;
    }

    // Same logic for <floor>: portal page is authoritative. Domoplaner ships
    // floor numbers that mismatch the portal in ~7% of offers (mainly Остров
    // Первых корпус 2). Bot must show the floor an agent sees on the listing.
    const pageFloor = offer.__floor_from_page;
    if (pageFloor != null) {
      const ymlFloor = offer.floor != null && offer.floor !== '' ? parseInt(offer.floor, 10) : null;
      if (ymlFloor !== pageFloor) {
        if (floorMismatches.length < 5) {
          floorMismatches.push({ id: offer['@_id'], url: offer.url, yml: ymlFloor, page: pageFloor });
        }
        offer.floor = String(pageFloor);
        floorOverriddenFromPage++;
      }
      delete offer.__floor_from_page;
    }

    const newDescription = buildEnrichedDescription(offer);
    if (newDescription && newDescription !== offer.description) {
      offer.description = newDescription;
      enrichedCount++;
    }
    // Strip the temporary __apt_number marker so it does not leak into XML output.
    delete offer.__apt_number;

    // Keep partner-portal URL from Domoplaner as-is. Was overridden to a
    // public Domoplaner deep-link in c925e9f for a B2C scenario; reverted
    // 2026-05-22 because Fizika consumes this feed in a B2B agent-only
    // chat (Flynn-ai) — the bot must cite booking.fizika.group/flat/<id>/
    // which is the partner listing URL agents are already logged into.
    // If a B2C variant is needed later, build a separate output.
  }

  // Replace offers list with the filtered set.
  data.yml_catalog.shop.offers.offer = alive;
  data.yml_catalog['@_date'] = new Date().toISOString();

  let out = '<?xml version="1.0" encoding="utf-8"?>\n' + builder.build(data.yml_catalog ? { yml_catalog: data.yml_catalog } : data);

  // Restore boolean-like attributes that fast-xml-parser flattens (e.g. <offer ... available> → available="true").
  out = out.replace(/(<offer\b[^>]*?)\bavailable(?=\s|>)/g, '$1available="true"');

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, out, 'utf8');

  console.log(JSON.stringify({
    source: process.env.LOCAL === '1' ? 'local' : SOURCE_URL,
    total_input: list.length,
    alive: alive.length,
    dropped: dropped.length,
    enriched: enrichedCount,
    rooms_normalized: roomsNormalized,
    rooms_overridden_from_title: roomsOverriddenFromTitle,
    rooms_mismatches_sample: roomsMismatches,
    floor_overridden_from_page: floorOverriddenFromPage,
    floor_mismatches_sample: floorMismatches,
    output: OUTPUT_PATH,
    bytes: out.length,
    dropped_sample: dropped.slice(0, 5),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
