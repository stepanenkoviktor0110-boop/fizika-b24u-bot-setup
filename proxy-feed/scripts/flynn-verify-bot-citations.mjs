// Verify that bot's cited "<описание квартиры> — <URL>" actually points to the right flat.
// Pulls last N assistant replies, extracts (claim, url), checks each on portal under login.

const PHONE = process.env.BOOKING_FIZIKA_LOGIN;
const PASS = process.env.BOOKING_FIZIKA_PASSWORD;
const FLYNN_TOKEN = process.env.FLYNN_TOKEN;
const APIKEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZ29ncW9rbmRyZ215aGlkeG9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4MDMwNjMsImV4cCI6MjA4NjM3OTA2M30.FqLhostjS4PHUJ_g3G1WLlpX8VhYYzWvA7uJi72demw';
const PROJECT_ID = 'c23660f9-0402-47a4-b0fd-2c38f26950f7';
const LIMIT = parseInt(process.env.LIMIT || '40', 10);

if (!FLYNN_TOKEN || !PHONE || !PASS) {
  console.error('Need FLYNN_TOKEN, BOOKING_FIZIKA_LOGIN, BOOKING_FIZIKA_PASSWORD');
  process.exit(1);
}

async function loginBooking() {
  const fd = new FormData();
  fd.append('phone', PHONE);
  fd.append('password', PASS);
  const res = await fetch('https://booking.fizika.group/auth/login/', { method:'POST', body:fd, redirect:'manual' });
  const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  const data = await res.json().catch(()=>({}));
  if (data?.success !== 1) throw new Error('booking login failed');
  const jar = new Map();
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    jar.set(pair.slice(0,eq).trim(), pair.slice(eq+1));
  }
  return Array.from(jar, ([k,v]) => `${k}=${v}`).join('; ');
}

function parsePortalPage(html) {
  const title = (html.match(/<title>([^<]+)<\/title>/i)?.[1] || '').trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const area = parseFloat(text.match(/(\d+(?:[.,]\d+)?)\s*м[²2]/)?.[1].replace(',','.') || '0');
  const priceMatch = text.match(/(\d[\d  ]{4,})\s*₽/);
  const price = priceMatch ? parseInt(priceMatch[1].replace(/[\s ]/g,''), 10) : null;
  const floor = parseInt(text.match(/Этаж\s+(\d+)\s+из\s+\d+/i)?.[1] || '0') || null;
  const aptNum = title.match(/№\s*(\d+)/)?.[1] || null;
  const complex = title.split('.').map(s=>s.trim()).filter(Boolean).at(-1);
  const rooms = (/студи/i.test(title) ? 0 : parseInt(title.match(/(\d+)-комн/i)?.[1] || '0')) || null;
  return { title, area, price, floor, aptNum, complex, rooms };
}

function parseBotClaim(line) {
  // Bot lines look like:  "Двухкомнатная, 72.47 м², Talento, корпус 1, эт. 3, 33 263 730 ₽, № 318152 — https://..."
  const areaM = line.match(/(\d+(?:[.,]\d+)?)\s*м[²2]/);
  const priceM = line.match(/(\d[\d  ,]{5,})\s*₽/);
  const floorM = line.match(/(\d+)\s*эт/i);
  const numM = line.match(/№\s*(\d+)/);
  const roomsM = line.match(/(студи|однокомн|1-комн|двухкомн|2-комн|трехкомн|трёхкомн|3-комн|четырёхкомн|4-комн)/i);
  const complexM = line.match(/(Talento|Таленто|Остров|Моисеенко|VIDI|Види)/i);
  return {
    area: areaM ? parseFloat(areaM[1].replace(',','.')) : null,
    price: priceM ? parseInt(priceM[1].replace(/[\s ,]/g,''),10) : null,
    floor: floorM ? parseInt(floorM[1],10) : null,
    num: numM ? numM[1] : null,
    rooms: roomsM ? (/студи/i.test(roomsM[1]) ? 0 : (/(1|однокомн)/i.test(roomsM[1]) ? 1 : /(2|двух)/i.test(roomsM[1]) ? 2 : /(3|трех|трёх)/i.test(roomsM[1]) ? 3 : /(4|четыр)/i.test(roomsM[1]) ? 4 : null)) : null,
    complex: complexM ? complexM[1] : null,
  };
}

const normComplex = s => (s||'').toLowerCase().replace(/жк|апартаменты|апарт|резиденции?/g,'').replace(/[^a-zа-я0-9]/gi,'');

async function main() {
  const flynnHeaders = { apikey: APIKEY, Authorization: `Bearer ${FLYNN_TOKEN}` };
  const msgsUrl = `https://flynn-ai.ru/rest/v1/messages?select=content,visitor_id,created_at&project_id=eq.${PROJECT_ID}&role=eq.assistant&order=created_at.desc&limit=${LIMIT}`;
  const msgs = await fetch(msgsUrl, { headers: flynnHeaders }).then(r=>r.json());

  const pairs = [];
  for (const m of msgs) {
    if (!m.content) continue;
    const lines = m.content.split(/\n+/);
    for (const line of lines) {
      const urlMatch = line.match(/(https:\/\/booking\.fizika\.group\/flat\/(\d+)\/?)/);
      if (!urlMatch) continue;
      const claim = parseBotClaim(line);
      // Only verify pairs where bot at least mentioned area + price + ЖК
      if (!claim.area || !claim.price || !claim.complex) continue;
      pairs.push({ when: m.created_at?.slice(0,19), visitor: m.visitor_id?.slice(0,12), claim, url: urlMatch[1], flat: urlMatch[2], line: line.slice(0,200) });
    }
  }

  console.log(`Found ${pairs.length} (claim, url) pairs to verify\n`);
  const cookie = await loginBooking();
  console.log('Booking login OK.\n');

  const mismatches = [];
  let i = 0, ok = 0;
  for (const p of pairs) {
    i++;
    const res = await fetch(p.url, { headers: { Cookie: cookie } });
    if (!res.ok) { console.log(`[${i}/${pairs.length}] HTTP ${res.status} for ${p.url}`); continue; }
    const portal = parsePortalPage(await res.text());
    const issues = [];
    if (p.claim.area != null && portal.area && Math.abs(p.claim.area - portal.area) > 0.5) issues.push(`area: said ${p.claim.area}, portal ${portal.area}`);
    if (p.claim.price != null && portal.price && Math.abs(p.claim.price - portal.price) > 50000) issues.push(`price: said ${p.claim.price}, portal ${portal.price}`);
    if (p.claim.floor != null && portal.floor && p.claim.floor !== portal.floor) issues.push(`floor: said ${p.claim.floor}, portal ${portal.floor}`);
    if (p.claim.rooms != null && portal.rooms != null && p.claim.rooms !== portal.rooms) issues.push(`rooms: said ${p.claim.rooms}, portal ${portal.rooms}`);
    if (p.claim.complex && portal.complex && normComplex(p.claim.complex) !== normComplex(portal.complex)) issues.push(`complex: said ${p.claim.complex}, portal ${portal.complex}`);
    if (issues.length === 0) ok++; else mismatches.push({ ...p, portal, issues });
  }
  console.log(`\n===========================`);
  console.log(`Verified: ${pairs.length}, MATCH: ${ok}, MISMATCH: ${mismatches.length}`);
  console.log(`===========================\n`);
  if (mismatches.length) {
    console.log('MISMATCHES:\n');
    for (const m of mismatches) {
      console.log(`[${m.when}] ${m.url}`);
      console.log(`  Bot said: ${m.line}`);
      console.log(`  Portal:   ${m.portal.title} | ${m.portal.area}м², ${m.portal.price}₽, эт.${m.portal.floor}`);
      console.log(`  Issues:   ${m.issues.join('; ')}`);
      console.log();
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
