import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_URL = process.env.FEED_SOURCE_URL
  ?? 'https://domoplaner.ru/dc-api/feeds/424-NvLi2AAieHuU8GCndxIPl0V34A10ijt0CbZbZKuMWhUzkkxnRp4NtLAgO7DN0c8H/';
const LOCAL_PATH = resolve(__dirname, '../../old/artifacts/domoplaner-feed-original-2026-05-09.yml');
const OUTPUT_PATH = resolve(__dirname, '../../public/feed.xml');

// Public deep-link to a flat in Domoplaner catalog widget. The catalog token
// `rRFkg1` is the same token the official project sites (moiseenko10.ru and
// siblings) embed, so it's safe to expose. `flat_id` matches <offer id="...">
// 1:1 across all four ЖК (Talento, Остров Первых, Моисеенко 10, VIDI),
// so no project-to-token mapping is needed. Replaces the agent-portal URL
// (booking.fizika.group/flat/<id>/) which redirects unauthenticated visitors
// to a login page — useless for the public chat widget audience.
const PUBLIC_CATALOG_URL = 'https://domoplaner.ru/catalog/424/rRFkg1/plans/?flat_id=';

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

function areaFromName(name) {
  if (!name) return null;
  const m = String(name).match(/(\d+(?:[.,]\d+)?)\s*м²/);
  if (!m) return null;
  const v = m[1].replace(',', '.');
  return `площадь ${v} квадратных метров, ${v} м²`;
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

function buildEnrichedDescription(offer) {
  const parts = [];

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

  const renovation = renovationLabel(offer.renovation);
  if (renovation) parts.push(renovation);

  if (offer.adress) parts.push(`адрес: ${offer.adress}`);

  // Append original description at the end, if any
  if (offer.description) parts.push(String(offer.description).trim());

  return parts.filter(Boolean).join('. ');
}

async function loadFeed() {
  if (process.env.LOCAL === '1') {
    return await readFile(LOCAL_PATH, 'utf8');
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
    return { ok: true, status: res.status, rooms_from_title: parseRoomsFromHtmlTitle(html) };
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
  const roomsMismatches = [];
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
    const newDescription = buildEnrichedDescription(offer);
    if (newDescription && newDescription !== offer.description) {
      offer.description = newDescription;
      enrichedCount++;
    }
    offer.url = `${PUBLIC_CATALOG_URL}${offer['@_id']}`;
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
    output: OUTPUT_PATH,
    bytes: out.length,
    dropped_sample: dropped.slice(0, 5),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
