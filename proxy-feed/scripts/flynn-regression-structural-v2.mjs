// Structural regression v2 — same classes, NEW phrasings + different ЖК/бюджеты/атрибуты.
// Цель: убедиться что промпт ловит структуру, а не запомненные кейсы.

const API_KEY = '1c8b1cf2-d0e6-47e4-966c-af35f2cd52c4';
const CHAT_URL = 'https://yngogqokndrgmyhidxor.supabase.co/functions/v1/widget-chat';

async function ask(q) {
  const visitor_id = `v2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tails = ['', '.', '?', '!', ' .', '  ', ' ?'];
  const text = q + tails[Math.random() * tails.length | 0];
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: API_KEY, messages: [{ role: 'user', content: text }], visitor_id }),
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return { json: await res.json() };
    return { text: await res.text() };
  } catch (e) { return { error: e.message }; }
}

function extractText(r) {
  if (r.json?.reply) return r.json.reply;
  if (r.json) return JSON.stringify(r.json);
  if (r.text) {
    const matches = [...r.text.matchAll(/"content":"([^"]*)"/g)];
    return matches.map(m => m[1]).join('');
  }
  return '';
}

const FALLBACK_RX = /[Оо]ставьте контакт|свяжется с вами|менеджер подберёт варианты вручную/;
const QUOTED_TPL_RX = /^"[\s\S]+"\s*$/;
const URL_RX = /https?:\/\/[^\s)]+/;
const SLICE_URL_RX = /\/catalog\/\d+\/(?:\?\w+=)/;
const FLAT_URL_RX = /\/flat\/\d+\//;
const SOFT_REFUSAL_RX = /в брошюре|у менеджера|обратитесь к менеджеру|информация в каталоге/i;

const CLASSES = [
  {
    class: 'A',
    name: 'Полная конкретика — НОВЫЕ ЖК/бюджеты',
    queries: [
      'однокомнатные VIDI до 17 миллионов',
      'студии Моисеенко 10 до 22 млн',
      'трёхкомнатные в Талент до 50',
    ],
    expect: { hasUrl: true, hasFlatUrl: true, noFallback: true },
  },
  {
    class: 'C',
    name: 'Один критерий — категория (новые формы)',
    queries: [
      'трёшка',
      'четырёхкомнатные есть',
      'студия',
    ],
    expect: { hasUrl: true, hasSliceUrl: true, noFallback: true },
  },
  {
    class: 'D',
    name: 'Один критерий — бюджет (новые суммы)',
    queries: [
      'до 50 миллионов',
      'бюджет 100 млн',
      'дешевле 20',
    ],
    expect: { hasUrl: true, hasSliceUrl: true, noFallback: true },
  },
  {
    class: 'E',
    name: 'Атрибут-фильтр (новые ЖК и атрибуты)',
    queries: [
      'двушки Острова с отделкой',
      'однушки в корпусе 2 Моисеенко',
      'студии VIDI на высоких этажах',
    ],
    expect: { hasUrl: true, noFallback: true },
  },
  {
    class: 'F',
    name: 'Count — новые ЖК',
    queries: [
      'количество однушек в VIDI',
      'сколько трёшек в Моисеенко',
      'сколько лотов в Острове до 30 млн',
    ],
    expect: { hasUrl: true, hasSliceUrl: true, noFallback: true, mustNotHaveExactCount: true },
  },
  {
    class: 'G',
    name: 'Мета-вопрос про ЖК (характеристики)',
    queries: [
      'материалы фасада VIDI',
      'лифты в Моисеенко',
      'школы рядом с Talento',
    ],
    expect: { hasUrl: true, noFallback: true, allowSoftRefusal: true },
  },
  {
    class: 'H',
    name: 'Multi-turn — короткое продолжение',
    queries: [
      { content: 'А в Моисеенко', context: [{ role: 'user', content: 'студии до 20 млн' }, { role: 'assistant', content: 'По студиям до 20 млн: VIDI 10.6 млн, Талент 19.7 млн.' }] },
      { content: 'А что в VIDI', context: [{ role: 'user', content: 'однушки до 30 млн' }, { role: 'assistant', content: '1-комн Talento 23.25, Моисеенко 32.79.' }] },
      { content: 'А подешевле?', context: [{ role: 'user', content: 'двушки Острова до 50 млн' }, { role: 'assistant', content: '2-комн Острова: 35-45 млн, варианты есть.' }] },
    ],
    expect: { hasUrl: true, noFallback: true },
    multiTurn: true,
  },
  {
    class: 'I',
    name: 'Superlative — новые объекты',
    queries: [
      'самая большая трёшка в Моисеенко',
      'самые дешёвые студии',
      'самая дорогая квартира в Талент',
    ],
    expect: { hasUrl: true, noFallback: true },
  },
];

function classify(text, expect) {
  const issues = [];
  const hasUrl = URL_RX.test(text);
  const hasFlat = FLAT_URL_RX.test(text);
  const hasSlice = SLICE_URL_RX.test(text);
  const hasFallback = FALLBACK_RX.test(text);
  const isQuotedTpl = QUOTED_TPL_RX.test(text.trim());
  const isSoftRefusal = SOFT_REFUSAL_RX.test(text);

  if (expect.hasUrl && !hasUrl) issues.push('no_url');
  if (expect.hasFlatUrl && !hasFlat && !isSoftRefusal) issues.push('no_flat_url');
  if (expect.hasSliceUrl && !hasSlice && !isSoftRefusal) issues.push('no_slice_url');
  if (expect.noFallback && hasFallback) issues.push('fallback');
  if (isQuotedTpl) issues.push('quoted_template');
  if (expect.mustNotHaveExactCount) {
    const numClaim = text.match(/(\d+)\s*(вариант|объект|квартир|лот|штук)/i);
    if (numClaim && !/не\s+(назыв|фиксир|точн)/i.test(text)) issues.push(`claims_exact_count:${numClaim[0]}`);
  }
  return issues;
}

async function main() {
  console.log(`Structural regression v2 — different ЖК, бюджеты, атрибуты\n`);
  const results = [];

  for (const cls of CLASSES) {
    console.log(`--- Class ${cls.class}: ${cls.name}`);
    for (const item of cls.queries) {
      const isObj = typeof item === 'object';
      const q = isObj ? item.content : item;
      const context = isObj ? item.context : null;
      let r;
      if (context) {
        const visitor_id = `v2mt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const tails = ['', '?', '.'];
        const text = q + tails[Math.random() * tails.length | 0];
        try {
          const res = await fetch(CHAT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: API_KEY, messages: context.concat([{ role: 'user', content: text }]), visitor_id }),
          });
          r = res.headers.get('content-type')?.includes('json') ? { json: await res.json() } : { text: await res.text() };
        } catch (e) { r = { error: e.message }; }
      } else {
        r = await ask(q);
      }
      const text = extractText(r);
      const issues = classify(text, cls.expect);
      const verdict = issues.length === 0 ? 'PASS' : 'FAIL';
      results.push({ class: cls.class, q, verdict, issues, preview: text.slice(0, 300) });
      console.log(`  ${verdict} "${q}"${issues.length ? ' — ' + issues.join(', ') : ''}`);
      await new Promise(r => setTimeout(r, 1200));
    }
    console.log();
  }

  const byClass = {};
  for (const r of results) {
    if (!byClass[r.class]) byClass[r.class] = { pass: 0, fail: 0 };
    byClass[r.class][r.verdict.toLowerCase()]++;
  }
  const total = results.length;
  const passed = results.filter(r => r.verdict === 'PASS').length;

  console.log(`===========================`);
  console.log(`OVERALL: ${passed}/${total}`);
  console.log(`By class:`);
  for (const [c, v] of Object.entries(byClass)) {
    console.log(`  ${c}: ${v.pass}/${v.pass + v.fail}`);
  }
  console.log(`===========================`);

  const fails = results.filter(r => r.verdict === 'FAIL');
  if (fails.length) {
    console.log(`\nFAILURES:\n`);
    for (const f of fails) {
      console.log(`[${f.class}] "${f.q}"`);
      console.log(`  ${f.issues.join(', ')}`);
      console.log(`  ${f.preview}`);
      console.log();
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
