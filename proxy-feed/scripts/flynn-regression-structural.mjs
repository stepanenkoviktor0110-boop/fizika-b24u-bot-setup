// Structural regression: 6 classes × 3 lexical variants = 18 tests.
// Each test checks STRUCTURAL properties of the response (has URL, no fallback,
// no quotes-template) instead of asserting exact strings.

const API_KEY = '1c8b1cf2-d0e6-47e4-966c-af35f2cd52c4';
const CHAT_URL = 'https://yngogqokndrgmyhidxor.supabase.co/functions/v1/widget-chat';

async function ask(q) {
  const visitor_id = `struct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Flynn caches responses by exact query string. Append natural trailing
  // punctuation/spaces — doesn't change meaning, but breaks cache key.
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
    // strip SSE wrappers
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

const CLASSES = [
  {
    class: 'A',
    name: 'Полная конкретика (ЖК + комнатность + бюджет)',
    queries: [
      'двушки Talento до 40 млн',
      'хочу 1-комн в Острове до 25 млн',
      'трёхкомнатная Моисеенко до 100 млн',
    ],
    expect: { hasUrl: true, hasFlatUrl: true, noFallback: true, noQuotedTpl: true },
  },
  {
    class: 'B',
    name: 'Конкретный лот (по №)',
    queries: [
      'расскажи про лот 480573',
      'что за квартира №317646',
      'покажи лот 318156',
    ],
    expect: { hasUrl: true, hasFlatUrl: true, noFallback: true, noQuotedTpl: true },
  },
  {
    class: 'C',
    name: 'Один критерий — категория',
    queries: [
      '1-комн',
      'однокомнатные?',
      'студии нужны',
    ],
    expect: { hasUrl: true, hasSliceUrl: true, noFallback: true, noQuotedTpl: true },
  },
  {
    class: 'D',
    name: 'Один критерий — бюджет',
    queries: [
      'до 40 млн',
      'бюджет 25 млн',
      'что есть до пяти миллионов',
    ],
    expect: { hasUrl: true, hasSliceUrl: true, noFallback: true, noQuotedTpl: true },
  },
  {
    class: 'E',
    name: 'Атрибут-фильтр',
    queries: [
      'двушки Моисеенко с отделкой',
      'квартиры с чистовой Моисеенко',
      'однушки Острова в корпусе 11',
    ],
    expect: { hasUrl: true, noFallback: true, noQuotedTpl: true },
  },
  {
    class: 'F',
    name: 'Count-запрос',
    queries: [
      'сколько студий в Острове',
      'количество 2-комн в Talento',
      'сколько 1-комн до 30 млн',
    ],
    expect: { hasUrl: true, noFallback: true, noQuotedTpl: true, mustNotHaveExactCount: true },
  },
];

function classify(text, expect) {
  const issues = [];
  const hasUrl = URL_RX.test(text);
  const hasFlat = FLAT_URL_RX.test(text);
  const hasSlice = SLICE_URL_RX.test(text);
  const hasFallback = FALLBACK_RX.test(text);
  const isQuotedTpl = QUOTED_TPL_RX.test(text.trim());

  if (expect.hasUrl && !hasUrl) issues.push('no_url');
  if (expect.hasFlatUrl && !hasFlat) issues.push('no_flat_url');
  if (expect.hasSliceUrl && !hasSlice) issues.push('no_slice_url');
  if (expect.noFallback && hasFallback) issues.push('fallback');
  if (expect.noQuotedTpl && isQuotedTpl) issues.push('quoted_template');
  // For count queries — accept "точное число не" / "не фиксируется" as healthy escalation
  if (expect.mustNotHaveExactCount) {
    const numClaim = text.match(/(\d+)\s*(вариант|объект|квартир|лот|штук)/i);
    if (numClaim && !/не\s+(назыв|фиксир|точн)/i.test(text)) issues.push(`claims_exact_count:${numClaim[0]}`);
  }
  return issues;
}

async function main() {
  console.log(`Structural regression — 6 classes × 3 variants = 18 tests\n`);
  const results = [];

  for (const cls of CLASSES) {
    console.log(`--- Class ${cls.class}: ${cls.name}`);
    for (const q of cls.queries) {
      const r = await ask(q);
      const text = extractText(r);
      const issues = classify(text, cls.expect);
      const verdict = issues.length === 0 ? 'PASS' : 'FAIL';
      results.push({ class: cls.class, q, verdict, issues, preview: text.slice(0, 250) });
      console.log(`  ${verdict} "${q}"${issues.length ? ' — ' + issues.join(', ') : ''}`);
      await new Promise(r => setTimeout(r, 1200));
    }
    console.log();
  }

  // Summary
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

  // Failures detail
  const fails = results.filter(r => r.verdict === 'FAIL');
  if (fails.length) {
    console.log(`\nFAILURES:\n`);
    for (const f of fails) {
      console.log(`[${f.class}] "${f.q}"`);
      console.log(`  Issues: ${f.issues.join(', ')}`);
      console.log(`  Preview: ${f.preview}`);
      console.log();
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
