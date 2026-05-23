import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FEED_PATH = resolve(__dirname, '../../public/feed.xml');
const OUT_REPORT = resolve(__dirname, '../../old/artifacts/verify-feed-vs-portal.json');

async function login() {
  const phone = process.env.BOOKING_FIZIKA_LOGIN;
  const password = process.env.BOOKING_FIZIKA_PASSWORD;
  if (!phone || !password) throw new Error('Set BOOKING_FIZIKA_LOGIN/PASSWORD');
  const fd = new FormData();
  fd.append('phone', phone);
  fd.append('password', password);
  const res = await fetch('https://booking.fizika.group/auth/login/', { method: 'POST', body: fd, redirect: 'manual' });
  const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  const data = await res.json().catch(() => ({}));
  if (!data || data.success !== 1) throw new Error('Login failed');
  const jar = new Map();
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  return Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
}

function parsePortal(html) {
  // Title pattern: "Студия, №29. Talento" / "1-комн. квартира, №7. Моисеенко 10"
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // Strip tags, normalize whitespace.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  // Area: "41.79 м2" or "41,79 м²"
  const areaMatch = text.match(/(\d+(?:[.,]\d+)?)\s*м[²2]/);
  const area = areaMatch ? parseFloat(areaMatch[1].replace(',', '.')) : null;

  // Price: "19 735 746 ₽" (with NBSP/regular space)
  const priceMatch = text.match(/(\d[\d  ]{4,})\s*₽/);
  const price = priceMatch ? parseInt(priceMatch[1].replace(/[\s ]/g, ''), 10) : null;

  // Floor: "Этаж 4 из 12"
  const floorMatch = text.match(/Этаж\s+(\d+)\s+из\s+(\d+)/i);
  const floor = floorMatch ? parseInt(floorMatch[1], 10) : null;

  // Complex name from title (last segment after ". ")
  let complex = null;
  if (title) {
    const segs = title.split('.').map(s => s.trim()).filter(Boolean);
    complex = segs[segs.length - 1] || null;
  }

  // Rooms from title: "Студия", "1-комн.", "3-комн."
  let rooms = null;
  if (title) {
    if (/студи/i.test(title)) rooms = 0;
    else {
      const m = title.match(/(\d+)-комн/i);
      if (m) rooms = parseInt(m[1], 10);
    }
  }

  return { title, area, price, floor, complex, rooms };
}

function normComplex(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/жк\s+/g, '').replace(/[^a-zа-я0-9]/gi, '');
}

function classifyMismatch(offer, portal) {
  const issues = [];
  const ymlAreaMatch = String(offer.name ?? '').match(/(\d+(?:[.,]\d+)?)\s*м²/);
  const ymlArea = ymlAreaMatch ? parseFloat(ymlAreaMatch[1].replace(',', '.')) : null;
  const ymlPrice = offer.price ? parseInt(offer.price, 10) : null;
  const ymlRooms = offer.rooms != null && offer.rooms !== '' ? parseInt(offer.rooms, 10) : null;
  const ymlFloor = offer.floor ? parseInt(offer.floor, 10) : null;
  const ymlComplex = offer['building-name'] ?? null;

  if (ymlArea != null && portal.area != null && Math.abs(ymlArea - portal.area) > 0.05) {
    issues.push({ field: 'area', yml: ymlArea, portal: portal.area });
  }
  if (ymlPrice != null && portal.price != null && Math.abs(ymlPrice - portal.price) > 1000) {
    issues.push({ field: 'price', yml: ymlPrice, portal: portal.price });
  }
  if (ymlRooms != null && portal.rooms != null && ymlRooms !== portal.rooms) {
    issues.push({ field: 'rooms', yml: ymlRooms, portal: portal.rooms });
  }
  if (ymlFloor != null && portal.floor != null && ymlFloor !== portal.floor) {
    issues.push({ field: 'floor', yml: ymlFloor, portal: portal.floor });
  }
  if (ymlComplex && portal.complex && normComplex(ymlComplex) !== normComplex(portal.complex)) {
    issues.push({ field: 'complex', yml: ymlComplex, portal: portal.complex });
  }
  return issues;
}

async function fetchOne(url, cookie) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { headers: { Cookie: cookie }, redirect: 'follow', signal: ctrl.signal });
    const html = await res.text();
    clearTimeout(t);
    return { ok: res.ok, status: res.status, finalUrl: res.url, html };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

async function main() {
  const xml = await readFile(FEED_PATH, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true });
  const data = parser.parse(xml);
  let offers = data?.yml_catalog?.shop?.offers?.offer ?? [];
  if (!Array.isArray(offers)) offers = [offers];

  // Only /flat/ for now (skip commerce — different page schema).
  const flats = offers.filter(o => o.url && /\/flat\//i.test(o.url));
  console.log(`Flats to verify: ${flats.length}`);

  const cookie = await login();
  console.log('Logged in.');

  const concurrency = 10;
  const results = [];
  let idx = 0, done = 0;

  async function worker() {
    while (idx < flats.length) {
      const i = idx++;
      const offer = flats[i];
      const res = await fetchOne(offer.url, cookie);
      done++;
      if (done % 20 === 0) process.stderr.write(`${done}/${flats.length}\n`);
      if (!res.ok || !res.html) {
        results.push({ id: offer['@_id'], url: offer.url, error: res.error || `http ${res.status}` });
        continue;
      }
      const portal = parsePortal(res.html);
      const issues = classifyMismatch(offer, portal);
      if (issues.length > 0) {
        results.push({ id: offer['@_id'], url: offer.url, name: offer.name, ymlBuilding: offer['building-name'], portalTitle: portal.title, issues });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const summary = {
    total: flats.length,
    mismatched: results.length,
    matched: flats.length - results.length,
    byField: {},
  };
  for (const r of results) {
    if (!r.issues) continue;
    for (const i of r.issues) summary.byField[i.field] = (summary.byField[i.field] ?? 0) + 1;
  }

  await writeFile(OUT_REPORT, JSON.stringify({ summary, mismatches: results }, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${OUT_REPORT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
