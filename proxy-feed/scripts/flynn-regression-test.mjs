// Regression battery against Flynn-AI widget API.
// Endpoint discovered from public widget-script: POST widget-chat with {api_key, messages, visitor_id}.
const API_KEY = '1c8b1cf2-d0e6-47e4-966c-af35f2cd52c4';
const CHAT_URL = 'https://yngogqokndrgmyhidxor.supabase.co/functions/v1/widget-chat';

async function ask(query, { timeout = 60000 } = {}) {
  const visitor_id = `regression-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: API_KEY, messages: [{ role: 'user', content: query }], visitor_id }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => '') };
    // Streaming SSE? Or JSON? Try both.
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      return { ok: true, json: await res.json() };
    }
    return { ok: true, text: await res.text() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function extractUrls(s) {
  return [...String(s ?? '').matchAll(/https?:\/\/[^\s"'<>)]+/g)].map(m => m[0]);
}

function extractText(result) {
  if (result.json) return JSON.stringify(result.json);
  return result.text ?? '';
}

const TESTS = [
  { id: 'R1', q: 'студии Talento до 20 млн', expect: { hasUrl: true, mustContain: ['Talento', '19.7'] } },
  { id: 'R2', q: 'двушки Моисеенко с отделкой', expect: { hasUrl: true, mustContain: ['Моисеенко'] } },
  { id: 'R3.1', q: 'однокомнатные любой ЖК', expect: { hasUrl: true } },
  { id: 'R3.2', q: 'до 30 млн самую классную', expect: { hasUrl: true } },
  { id: 'R8', q: 'покажи планировку студии Talento 41.79 м²', expect: { hasUrl: true, mustContain: ['storage.yandexcloud', 'jpg'] } },
  { id: 'C1', q: 'сколько студий в Talento до 20 млн', expect: { hasUrl: true } },
  { id: 'C2', q: 'сколько двушек в Моисеенко 10 с чистовой отделкой', expect: { hasUrl: true, mustNotContain: ['оставьте контакт', 'свяжется с вами'] } },
  { id: 'C3', q: 'сколько 1-комнатных до 30 млн во всех ЖК суммарно', expect: { hasUrl: true } },
  { id: 'C4', q: 'сколько студий в Острове Первых', expect: { hasUrl: true } },
  { id: 'KRL', q: 'студии Острова Первых каталог', expect: { hasUrl: true, mustContain: ['%D1%81%D1%82', '/catalog/184/'] } },
];

async function main() {
  console.log(`Running ${TESTS.length} regression tests against Flynn widget API`);
  console.log(`Endpoint: ${CHAT_URL}\n`);

  const results = [];
  for (const t of TESTS) {
    process.stderr.write(`${t.id}: ${t.q}\n`);
    const r = await ask(t.q);
    const body = extractText(r);
    const urls = extractUrls(body);
    const issues = [];
    if (!r.ok) issues.push(`api_error: ${r.error ?? r.status}`);
    if (t.expect.hasUrl && urls.length === 0) issues.push('no_url_in_answer');
    for (const must of (t.expect.mustContain ?? [])) {
      if (!body.includes(must)) issues.push(`missing: "${must}"`);
    }
    for (const mnot of (t.expect.mustNotContain ?? [])) {
      if (body.includes(mnot)) issues.push(`forbidden: "${mnot}"`);
    }
    const verdict = issues.length === 0 ? 'PASS' : 'FAIL';
    results.push({ id: t.id, q: t.q, verdict, issues, urls: urls.slice(0, 5), preview: body.slice(0, 400) });
    console.log(`  ${verdict}${issues.length ? ' — ' + issues.join('; ') : ''}`);
    if (urls.length) console.log(`  URLs: ${urls.slice(0, 3).join(' | ')}`);
    console.log();
    await new Promise(r => setTimeout(r, 1500));
  }

  const passed = results.filter(r => r.verdict === 'PASS').length;
  console.log('===========================');
  console.log(`PASS: ${passed}/${results.length}`);
  console.log('===========================');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
