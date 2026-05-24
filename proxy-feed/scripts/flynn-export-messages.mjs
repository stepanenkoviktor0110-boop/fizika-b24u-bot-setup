// Export Flynn chat history for offline analysis.
//
// Auth: open https://flynn-ai.ru/dashboard in a browser, login as owner,
// then in DevTools console run:
//   JSON.parse(localStorage['sb-flynn-ai-auth-token']).access_token
// Paste the result as FLYNN_TOKEN env var.
//
// Usage:
//   FLYNN_TOKEN=eyJ... node proxy-feed/scripts/flynn-export-messages.mjs
//   FLYNN_TOKEN=... LIMIT=500 OUT=messages.json node proxy-feed/...
import { writeFile } from 'node:fs/promises';

const TOKEN = process.env.FLYNN_TOKEN;
const APIKEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZ29ncW9rbmRyZ215aGlkeG9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4MDMwNjMsImV4cCI6MjA4NjM3OTA2M30.FqLhostjS4PHUJ_g3G1WLlpX8VhYYzWvA7uJi72demw';
const PROJECT_ID = process.env.PROJECT_ID || 'c23660f9-0402-47a4-b0fd-2c38f26950f7';
const LIMIT = process.env.LIMIT || 500;
const OUT = process.env.OUT || `flynn-messages-${new Date().toISOString().slice(0,10)}.json`;

if (!TOKEN) { console.error('Set FLYNN_TOKEN env (see file header)'); process.exit(1); }

const headers = { apikey: APIKEY, Authorization: `Bearer ${TOKEN}` };

async function main() {
  const url = `https://flynn-ai.ru/rest/v1/messages?select=*&project_id=eq.${PROJECT_ID}&order=created_at.desc&limit=${LIMIT}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const msgs = await res.json();
  await writeFile(OUT, JSON.stringify(msgs, null, 2), 'utf8');

  // Quick summary
  const byRole = msgs.reduce((a,m) => (a[m.role]=(a[m.role]||0)+1, a), {});
  const errors = msgs.filter(m => m.is_error).length;
  const avgRT = Math.round(msgs.filter(m=>m.response_time_ms).reduce((s,m)=>s+m.response_time_ms,0) / Math.max(1, msgs.filter(m=>m.response_time_ms).length));
  const visitors = new Set(msgs.map(m=>m.visitor_id)).size;

  console.log(JSON.stringify({ saved: OUT, total: msgs.length, byRole, errors, avgRespTimeMs: avgRT, uniqueVisitors: visitors, range: { first: msgs.at(-1)?.created_at, last: msgs[0]?.created_at } }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
