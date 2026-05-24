// Audit Flynn message history for failures.
// Pulls assistant replies and tags problems by pattern, then groups by visitor (whole dialog).
//
// Usage: FLYNN_TOKEN=<jwt> node proxy-feed/scripts/flynn-audit-messages.mjs

import { writeFile } from 'node:fs/promises';

const TOKEN = process.env.FLYNN_TOKEN;
const APIKEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZ29ncW9rbmRyZ215aGlkeG9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4MDMwNjMsImV4cCI6MjA4NjM3OTA2M30.FqLhostjS4PHUJ_g3G1WLlpX8VhYYzWvA7uJi72demw';
const PROJECT_ID = process.env.PROJECT_ID || 'c23660f9-0402-47a4-b0fd-2c38f26950f7';
const LIMIT = parseInt(process.env.LIMIT || '1000', 10);

if (!TOKEN) { console.error('Set FLYNN_TOKEN env'); process.exit(1); }

const FALLBACK_RX = /[Оо]ставьте контакт|свяжется с вами|менеджер подберёт варианты вручную/;
const VAGUE_REFUSAL_RX = /(к сожалению|по вашему запросу.*нет|не зафиксирован|не выгружен|не нашёл|нет данных|не располагаю)/i;
const MANAGER_RX = /к менеджеру|Ирина Леус|Полина Михайленко|свяжитесь с/i;
const URL_RX = /https?:\/\/[^\s)]+/;
const QUOTED_TPL_RX = /^"[^"]+"$/;

function classify(content, role) {
  if (role !== 'assistant') return [];
  const flags = [];
  if (FALLBACK_RX.test(content)) flags.push('FALLBACK');
  if (QUOTED_TPL_RX.test(content.trim())) flags.push('QUOTED_TEMPLATE');
  if (VAGUE_REFUSAL_RX.test(content) && !URL_RX.test(content)) flags.push('VAGUE_NO_URL');
  if (MANAGER_RX.test(content) && !URL_RX.test(content)) flags.push('MANAGER_ESCALATION_NO_URL');
  if (content.length < 50 && role === 'assistant') flags.push('TOO_SHORT');
  if (content.length < 200 && !URL_RX.test(content) && role === 'assistant') flags.push('NO_URL_SHORT');
  return flags;
}

async function main() {
  const headers = { apikey: APIKEY, Authorization: `Bearer ${TOKEN}` };
  const url = `https://flynn-ai.ru/rest/v1/messages?select=*&project_id=eq.${PROJECT_ID}&order=created_at.asc&limit=${LIMIT}`;
  const msgs = await fetch(url, { headers }).then(r => r.json());

  // Group by visitor → dialog
  const dialogs = {};
  for (const m of msgs) {
    if (!dialogs[m.visitor_id]) dialogs[m.visitor_id] = [];
    dialogs[m.visitor_id].push(m);
  }

  // For each assistant reply find preceding user msg, classify, collect failures
  const failures = [];
  let totalAssistant = 0;
  let totalDialogs = Object.keys(dialogs).length;
  const flagCounts = {};

  for (const [visitor, list] of Object.entries(dialogs)) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    let lastUser = null;
    for (const m of list) {
      if (m.role === 'user') { lastUser = m; continue; }
      if (m.role !== 'assistant') continue;
      totalAssistant++;
      const flags = classify(m.content || '', 'assistant');
      for (const f of flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
      if (flags.length) {
        failures.push({
          visitor: visitor.slice(0, 16),
          when: m.created_at,
          user_q: (lastUser?.content || '').slice(0, 200),
          assistant: (m.content || '').slice(0, 400),
          flags,
          tokens: m.token_count,
          ms: m.response_time_ms,
        });
      }
    }
  }

  const summary = {
    range: { first: msgs[0]?.created_at, last: msgs[msgs.length - 1]?.created_at },
    total_messages: msgs.length,
    total_dialogs: totalDialogs,
    total_assistant_replies: totalAssistant,
    flagged_replies: failures.length,
    flag_breakdown: flagCounts,
  };

  await writeFile('flynn-audit-failures.json', JSON.stringify({ summary, failures }, null, 2), 'utf8');

  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nFailures saved to flynn-audit-failures.json (${failures.length} entries).`);
  console.log(`\n--- TOP 10 FAILURES (most recent) ---\n`);
  for (const f of failures.slice(-10).reverse()) {
    console.log(`[${f.flags.join(',')}] ${f.when}`);
    console.log(`  Q: ${f.user_q}`);
    console.log(`  A: ${f.assistant.slice(0, 200)}`);
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
