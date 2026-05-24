// Full audit: pull entire history (excluding test traffic), classify each
// assistant reply, cross-check claims against the live feed.
//
// Categories of failures:
//   FALLBACK         — backend-fallback "оставьте контакт"
//   FALSE_NEGATIVE   — bot said "нет" but feed has matching offers
//   URL_MISMATCH     — URL points to a different flat than described
//   HALLUCINATED     — attributes (area/price/floor) not in feed for given URL
//   META_QUESTION    — meta-question about ЖК (legitimate "to manager")
//   TOO_SHORT        — very short reply, likely refusal
//   OK               — answer with URL + matching feed offer

import { readFile, writeFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';

const FLYNN_TOKEN = process.env.FLYNN_TOKEN;
const APIKEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZ29ncW9rbmRyZ215aGlkeG9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4MDMwNjMsImV4cCI6MjA4NjM3OTA2M30.FqLhostjS4PHUJ_g3G1WLlpX8VhYYzWvA7uJi72demw';
const PROJECT_ID = 'c23660f9-0402-47a4-b0fd-2c38f26950f7';
const LIMIT = parseInt(process.env.LIMIT || '500', 10);

if (!FLYNN_TOKEN) { console.error('Set FLYNN_TOKEN'); process.exit(1); }

const COMPLEX_ID = { Talento: 183, 'Talento': 183, Острово: 184, 'Остров Первых': 184, Моисеенко: 181, 'Моисеенко 10': 181, VIDI: 182 };

async function loadFeed() {
  // Use the local rebuilt feed.xml (most recent state of indexed data).
  const xml = await readFile('public/feed.xml', 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true });
  const data = parser.parse(xml);
  const offers = data?.yml_catalog?.shop?.offers?.offer ?? [];
  const list = Array.isArray(offers) ? offers : [offers];
  // Index by flat URL
  const byFlat = {};
  for (const o of list) {
    const m = o.url?.match(/\/flat\/(\d+)\//);
    if (m) byFlat[m[1]] = o;
  }
  return { list, byFlat };
}

const FALLBACK_RX = /[Оо]ставьте контакт|свяжется с вами|менеджер подберёт варианты вручную/;
const QUOTED_TPL_RX = /^"[^"]+"\s*$/;
const VAGUE_NO_RX = /(?:^|\s)(?:не\s+(?:нашёл|найден|зафиксирован|выгружен|представлен)|нет\s+подходящ|нет\s+доступн|нет\s+вариант|отсутству[ею]т|совпадений\s+нет)/i;
const META_KEYWORDS = /(потолк|двери|окна|материал|фасад|парковк|лифт|инфраструктур|школ|детсад|благоустр|безопасн|транспорт)/i;
const URL_RX = /https:\/\/booking\.fizika\.group\/flat\/(\d+)\//g;

function extractClaim(line) {
  return {
    area: parseFloat((line.match(/(\d+(?:[.,]\d+)?)\s*м[²2]/)?.[1] || '0').replace(',','.')) || null,
    price: (() => { const m = line.match(/,\s*((?:\d{1,3}(?:[\s ]\d{3})+|\d{4,}))\s*₽/); return m ? parseInt(m[1].replace(/[\s ,]/g,''),10) : null; })(),
    floor: parseInt(line.match(/(?:^|[\s,])эт\.?\s*(\d+)/i)?.[1] || '0') || null,
    rooms: (() => { const m = line.match(/(студи|однокомн|1-комн|двухкомн|2-комн|трехкомн|трёхкомн|3-комн|четырёхкомн|4-комн)/i)?.[1]; if (!m) return null; if (/студи/i.test(m)) return 0; if (/(1|одно)/i.test(m)) return 1; if (/(2|двух)/i.test(m)) return 2; if (/(3|трёх|трех)/i.test(m)) return 3; if (/(4|четыр)/i.test(m)) return 4; return null; })(),
  };
}

function matchOfferToUserQuery(query, feed) {
  // Very approximate: find offers whose ЖК + rooms + maxPrice from query are present.
  const q = query.toLowerCase();
  let complex = null;
  if (/talento|таленто|талент/.test(q)) complex = 'Talento';
  else if (/остров/.test(q)) complex = 'Остров Первых';
  else if (/моисеенко/.test(q)) complex = 'Моисеенко 10';
  else if (/vidi|види/.test(q)) complex = 'VIDI';
  let rooms = null;
  if (/студи/.test(q)) rooms = 0;
  else if (/однушк|однокомн|1-комн|одна\s*комн/.test(q)) rooms = 1;
  else if (/двушк|двухкомн|2-комн|две\s*комн/.test(q)) rooms = 2;
  else if (/трёшк|трешк|трёхкомн|трехкомн|3-комн|три\s*комн/.test(q)) rooms = 3;
  else if (/четырёхкомн|четырехкомн|4-комн/.test(q)) rooms = 4;
  let maxPrice = null;
  const pm = q.match(/до\s+(\d+)\s*(?:млн|миллион)/);
  if (pm) maxPrice = parseInt(pm[1], 10) * 1000000;
  return feed.list.filter(o => {
    if (complex && o['building-name'] && !o['building-name'].toLowerCase().includes(complex.toLowerCase().split(' ')[0])) return false;
    if (rooms !== null && o.rooms != null && parseInt(o.rooms, 10) !== rooms) return false;
    if (maxPrice && parseInt(o.price, 10) > maxPrice) return false;
    return true;
  });
}

function classify(userQ, content, feed) {
  const flags = [];
  const len = content.length;
  if (FALLBACK_RX.test(content)) flags.push('FALLBACK');
  if (QUOTED_TPL_RX.test(content.trim())) flags.push('QUOTED_TPL');
  if (len < 80) flags.push('TOO_SHORT');

  const urls = [...content.matchAll(URL_RX)].map(m => m[1]);
  const lines = content.split(/\n+/);
  const claimLines = lines.filter(l => URL_RX.test(l));
  URL_RX.lastIndex = 0; // reset stateful regex

  // URL/desc mismatch — bot's description says rooms/complex X, feed for that URL says Y
  for (const line of claimLines) {
    const m = line.match(/https:\/\/booking\.fizika\.group\/flat\/(\d+)\//);
    if (!m) continue;
    const flat = m[1];
    const offer = feed.byFlat[flat];
    if (!offer) { flags.push('URL_NOT_IN_FEED'); continue; }
    const claim = extractClaim(line);
    const offerRooms = offer.rooms != null ? parseInt(offer.rooms, 10) : null;
    const offerPrice = offer.price ? parseInt(offer.price, 10) : null;
    const offerArea = (offer.name?.match(/(\d+(?:[.,]\d+)?)\s*м²/)?.[1] || '').replace(',','.');
    if (claim.rooms !== null && offerRooms !== null && claim.rooms !== offerRooms) { flags.push(`URL_DESC_MISMATCH:rooms_${claim.rooms}_vs_${offerRooms}`); }
    if (claim.price && offerPrice && Math.abs(claim.price - offerPrice) > 100000) { flags.push(`URL_DESC_MISMATCH:price`); }
    if (claim.area && offerArea && Math.abs(claim.area - parseFloat(offerArea)) > 0.5) { flags.push(`URL_DESC_MISMATCH:area`); }
    if (claim.floor && offer.floor && claim.floor !== parseInt(offer.floor, 10)) { flags.push(`URL_DESC_MISMATCH:floor`); }
  }

  // FALSE_NEGATIVE — bot said "нет/не нашёл" but feed has matching offers for the user query
  if (VAGUE_NO_RX.test(content) && !urls.length) {
    const matches = matchOfferToUserQuery(userQ || '', feed);
    if (matches.length > 0) flags.push(`FALSE_NEGATIVE:${matches.length}_in_feed`);
  }

  // META_QUESTION — мета-вопрос про ЖК (легитимно "к менеджеру")
  if (META_KEYWORDS.test(userQ || '')) flags.push('META_QUESTION');

  if (flags.length === 0) flags.push('OK');
  return { flags, urls, claimLines: claimLines.length };
}

async function main() {
  const flynnHeaders = { apikey: APIKEY, Authorization: `Bearer ${FLYNN_TOKEN}` };
  console.error(`Loading feed...`);
  const feed = await loadFeed();
  console.error(`Feed: ${feed.list.length} offers, ${Object.keys(feed.byFlat).length} indexed by flat-id`);

  console.error(`Fetching last ${LIMIT} messages...`);
  const msgs = await fetch(`https://flynn-ai.ru/rest/v1/messages?select=*&project_id=eq.${PROJECT_ID}&order=created_at.asc&limit=${LIMIT}`, { headers: flynnHeaders }).then(r=>r.json());

  // Group user→assistant pairs by visitor + sequence
  const byVisitor = {};
  for (const m of msgs) {
    if (!byVisitor[m.visitor_id]) byVisitor[m.visitor_id] = [];
    byVisitor[m.visitor_id].push(m);
  }

  const audited = [];
  const flagCounts = {};
  let totalAssistant = 0;
  for (const [visitor, list] of Object.entries(byVisitor)) {
    if (/^(regression|audit|warmup|verify|c2|oneparam|fresh|reproduce|cache|struct|v2|hist2|apt|isolate|after-fix|verify2|meta|doors|final|warm|hist|v2mt|tail-test|recent)/.test(visitor)) continue;
    list.sort((a,b) => a.created_at.localeCompare(b.created_at));
    let lastUserQ = null;
    for (const m of list) {
      if (m.role === 'user') { lastUserQ = m.content; continue; }
      if (m.role !== 'assistant') continue;
      totalAssistant++;
      const { flags } = classify(lastUserQ, m.content || '', feed);
      for (const f of flags) {
        const cat = f.split(':')[0];
        flagCounts[cat] = (flagCounts[cat] || 0) + 1;
      }
      if (!flags.includes('OK')) {
        audited.push({ when: m.created_at?.slice(0,19), visitor: visitor.slice(0,12), q: (lastUserQ||'').slice(0,150), flags, a: (m.content||'').slice(0,300) });
      }
    }
  }

  console.log(`\n=== Total assistant replies from real users: ${totalAssistant}`);
  console.log(`=== Failure breakdown:`);
  const sorted = Object.entries(flagCounts).sort((a,b) => b[1]-a[1]);
  for (const [k, v] of sorted) console.log(`   ${k}: ${v}`);

  await writeFile('full-audit-failures.json', JSON.stringify(audited, null, 2), 'utf8');
  console.log(`\nFailure details written to full-audit-failures.json (${audited.length} entries)`);

  // Print top 15 most recent failures with context
  console.log(`\n--- 15 MOST RECENT FAILURES ---\n`);
  for (const f of audited.slice(-15).reverse()) {
    console.log(`[${f.when}] visitor=${f.visitor} | flags=${f.flags.join(',')}`);
    console.log(`  Q: ${f.q}`);
    console.log(`  A: ${f.a.slice(0, 200)}`);
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
