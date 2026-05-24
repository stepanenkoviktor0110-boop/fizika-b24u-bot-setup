// Deterministic answerer: take 10 historically-failed queries, parse them,
// query the feed directly, output exactly what a correct bot would say.
// No LLM, no RAG — just structured query against YML.

import { XMLParser } from 'fast-xml-parser';
import { readFile } from 'node:fs/promises';

const xml = await readFile('public/feed.xml', 'utf8');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true });
const data = parser.parse(xml);
const offers = (data?.yml_catalog?.shop?.offers?.offer ?? []);
const list = (Array.isArray(offers) ? offers : [offers]).map(o => ({
  url: o.url,
  building: o['building-name'],
  rooms: o.rooms != null ? parseInt(o.rooms, 10) : null,
  price: o.price ? parseInt(o.price, 10) : null,
  area: parseFloat((o.name?.match(/(\d+(?:[.,]\d+)?)/)?.[1] || '0').replace(',', '.')) || null,
  floor: o.floor ? parseInt(o.floor, 10) : null,
  renovation: o.renovation,
  name: o.name,
  section: o['building-section'],
}));

const COMPLEX = {
  talento:    { id: 183, full: 'Talento',         min: 'талент' },
  ostrov:     { id: 184, full: 'Остров Первых',   min: 'остров' },
  moiseenko:  { id: 181, full: 'Моисеенко 10',    min: 'моисеенко' },
  vidi:       { id: 182, full: 'VIDI',            min: 'vidi' },
};

function detectComplex(q) {
  const l = q.toLowerCase();
  if (/talento|таленто|талент/.test(l)) return 'talento';
  if (/остров/.test(l)) return 'ostrov';
  if (/моисеенко/.test(l)) return 'moiseenko';
  if (/vidi|види/.test(l)) return 'vidi';
  return null;
}

function detectRooms(q) {
  const l = q.toLowerCase();
  if (/студи/.test(l)) return 0;
  if (/однушк|однокомн|1-комн/.test(l)) return 1;
  if (/двушк|двухкомн|2-комн/.test(l)) return 2;
  if (/трёшк|трешк|трёхкомн|трехкомн|3-комн/.test(l)) return 3;
  if (/четыр.+комн|4-комн/.test(l)) return 4;
  return null;
}

function detectBudget(q) {
  const l = q.toLowerCase().replace(/ /g, ' ');
  // "до 20 млн", "до 15 000 000", "до пяти миллионов" etc.
  const m1 = l.match(/до\s+(\d+(?:[.,]\d+)?)\s*(млн|миллион)/);
  if (m1) return parseFloat(m1[1].replace(',', '.')) * 1_000_000;
  const m2 = l.match(/до\s+(\d[\d\s]{4,})/);
  if (m2) return parseInt(m2[1].replace(/\s/g, ''), 10);
  const m3 = l.match(/бюджет\s+(\d+)/);
  if (m3) return parseInt(m3[1], 10) * 1_000_000;
  return null;
}

function detectIntent(q) {
  const l = q.toLowerCase();
  if (/сколько|количеств/.test(l)) return 'count';
  if (/(самая\s+(?:большая|дорогая|маленькая)|самое\s+(?:дорогое|дешёвое|дешевое|маленькое))/.test(l)) return 'superlative_max';
  if (/(самая\s+дешёв|самая\s+дешев|самый\s+дешёв|самый\s+дешев)/.test(l)) return 'superlative_min';
  if (/^а\s+/.test(l) && q.split(/\s+/).length <= 4) return 'multi_turn_short';
  return 'select';
}

function sliceUrl(complex, rooms, budget) {
  if (!complex) return null;
  const id = COMPLEX[complex].id;
  const params = [];
  if (rooms !== null) params.push(`rooms=${rooms === 0 ? '%D1%81%D1%82' : rooms}`);
  if (budget) params.push(`maxPrice=${budget}`);
  return `https://booking.fizika.group/catalog/${id}/${params.length ? '?' + params.join('&') : ''}`;
}

function fmtOffer(o) {
  return `— ${o.name}, ${COMPLEX[Object.keys(COMPLEX).find(k => o.building?.toLowerCase().includes(COMPLEX[k].min)) || 'talento']?.full || o.building}, эт.${o.floor}, ${(o.price/1e6).toFixed(2).replace(/\.?0+$/,'')} млн ₽ — ${o.url}`;
}

function filter(complex, rooms, budget) {
  return list.filter(o => {
    if (complex && !o.building?.toLowerCase().includes(COMPLEX[complex].min)) return false;
    if (rooms !== null && rooms !== undefined && o.rooms !== rooms) return false;
    if (budget && o.price > budget) return false;
    return true;
  });
}

function answer(q, ctx = null) {
  const complex = detectComplex(q) || (ctx?.complex);
  const rooms = detectRooms(q) ?? (ctx?.rooms);
  const budget = detectBudget(q) ?? (ctx?.budget);
  const intent = detectIntent(q);

  if (intent === 'multi_turn_short' && complex && ctx) {
    // inherit rooms+budget from context, replace complex
    return answer(`${ctx.rooms_text || ''} ${complex} ${ctx.budget_text || ''}`.trim(), { ...ctx, complex });
  }

  const matches = filter(complex, rooms, budget);

  if (intent === 'count') {
    const slice = sliceUrl(complex, rooms, budget);
    const out = [`По фильтру в каталоге актуальный список: ${slice}`];
    if (matches.length) {
      out.push(`Примеры в базе:`);
      for (const o of matches.slice(0, 3)) out.push(fmtOffer(o));
    }
    return out.join('\n');
  }

  if (intent === 'superlative_max') {
    if (!matches.length) return `По фильтру нет: ${sliceUrl(complex, rooms, budget)}`;
    const sorted = [...matches].sort((a, b) => (b.area || 0) - (a.area || 0));
    const top = sorted[0];
    return `Самая большая по площади: ${fmtOffer(top)}\nСортировка по убыванию площади в каталоге: ${sliceUrl(complex, rooms, budget)}`;
  }

  if (intent === 'superlative_min') {
    if (!matches.length) return `По фильтру нет: ${sliceUrl(complex, rooms, budget)}`;
    const sorted = [...matches].sort((a, b) => (a.price || 0) - (b.price || 0));
    const top = sorted[0];
    return `Самая дешёвая: ${fmtOffer(top)}\nСортировка по возрастанию цены: ${sliceUrl(complex, rooms, budget)}`;
  }

  // select
  if (matches.length === 0) {
    // budget below minimum?
    if (budget && complex !== null) {
      const allInComplex = filter(complex, rooms);
      if (allInComplex.length) {
        const cheapest = Math.min(...allInComplex.map(o => o.price));
        return `В бюджете до ${(budget/1e6).toFixed(1)} млн ничего нет. Минимальная цена для этого фильтра — ${(cheapest/1e6).toFixed(2)} млн.\nПолный каталог: ${sliceUrl(complex, rooms, null)}`;
      }
    }
    return `По фильтру совпадений нет. Каталог: ${sliceUrl(complex, rooms, null) || 'https://booking.fizika.group/'}`;
  }

  const out = matches.length > 3
    ? matches.sort((a,b) => a.price - b.price).slice(0, 3)
    : matches;
  return `Найдено ${matches.length}, показываю ${out.length}:\n` + out.map(fmtOffer).join('\n') + `\nКаталог: ${sliceUrl(complex, rooms, budget)}`;
}

const TESTS = [
  { q: 'Есть трешки в острове', ctx: null, was: 'бот: "точных совпадений нет"' },
  { q: 'сколько двушек в Моисеенко 10 с чистовой отделкой', ctx: null, was: 'бот: FALLBACK' },
  { q: 'что есть в Talento до 40 млн', ctx: null, was: 'бот: FALLBACK' },
  { q: 'Какая самая большая по площади', ctx: { complex: 'ostrov', rooms: 2, rooms_text: 'двушки' }, was: 'бот: выдумал 88.58 м² 35.25 млн' },
  { q: 'Какая самая дешевая трешка в острове', ctx: null, was: 'бот: дал 35.77, не самую дешёвую' },
  { q: 'Есть двушки в острове до 20 млн', ctx: null, was: 'бот: не сказал явно, что в бюджете нет' },
  { q: 'Есть однушки до 15 000 000', ctx: null, was: 'бот: выдал 23.25 без чёткой пометки' },
  { q: 'А в острове', ctx: { complex: 'ostrov', rooms: 2, rooms_text: 'двушки', budget_text: 'на высоких этажах' }, was: 'бот: FALLBACK' },
  { q: 'двушки Talento до 40 млн', ctx: null, was: 'бот: работает, но иногда мешает URL' },
  { q: 'трёшки в Talento', ctx: null, was: 'бот: проверка' },
];

console.log(`Feed: ${list.length} offers loaded.\n`);
for (const t of TESTS) {
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Q: ${t.q}`);
  console.log(`Было в боте: ${t.was}`);
  console.log(`────`);
  console.log(answer(t.q, t.ctx));
  console.log();
}
