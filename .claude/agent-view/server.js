#!/usr/bin/env node
'use strict';
/**
 * Bug-Free Eureka agent view — a tiny, read-only, project-scoped dashboard on http://localhost:4778.
 *
 * Shows ONLY this repository's team: roster from .claude/agents/*.md, live/recent activity from
 * .claude/agent-activity.log (written by the SubagentStart/Stop hook), and work-order status from
 * docs/WORK_ORDERS.md. It never reads another project's files, so it cannot show Jyotish Stack
 * (which keeps its own view on :4777).
 *
 * Security: binds 127.0.0.1 only; GET/HEAD only (others 405); Host must be localhost/127.0.0.1:<port>
 * (blocks DNS rebinding); cross-site fetches rejected; strict CSP; all data rendered as text.
 * Zero dependencies. Port: AGENT_VIEW_PORT (default 4778).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT = 'bug-free-eureka';
const TITLE = 'Bug-Free Eureka';
const LEAD = 'eureka-lead';
const PORT = Number(process.env.AGENT_VIEW_PORT || 4778);
const ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');
const LOG = path.join(ROOT, '.claude', 'agent-activity.log');
const WO = path.join(ROOT, 'docs', 'WORK_ORDERS.md');
const MAX_LOG_TAIL = 256 * 1024;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) { process.stderr.write('agent-view: invalid AGENT_VIEW_PORT\n'); process.exit(2); }

function readSafe(file, max = 1024 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return '';
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, max);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len); // tail when larger than max
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
}

function roster() {
  try {
    return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).sort().map((f) => {
      const head = (/^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(readSafe(path.join(AGENTS_DIR, f), 64 * 1024)) || [])[1] || '';
      const name = ((/^name:\s*(.+)$/m.exec(head) || [])[1] || f.replace(/\.md$/, '')).trim();
      const desc = ((/^description:\s*(.+)$/m.exec(head) || [])[1] || '').trim();
      const model = ((/^model:\s*(.+)$/m.exec(head) || [])[1] || 'session').trim();
      const role = desc.split(/\.\s/)[0].replace(/\s+/g, ' ');
      return { name, model, lead: name === LEAD, role: role.length > 120 ? `${role.slice(0, 119)}…` : role };
    });
  } catch (_) { return []; }
}

function activity() {
  const lines = readSafe(LOG, MAX_LOG_TAIL).split(/\r?\n/).filter(Boolean);
  const events = [];
  for (const line of lines) {
    const [at, event, agent, id] = line.split('\t');
    if (!at || !event || !agent || Number.isNaN(Date.parse(at))) continue;
    events.push({ at, event, agent, id: id || '' });
  }
  // Active = started and not yet stopped (matched by id, else by agent name).
  const open = new Map();
  for (const e of events) {
    const key = e.id || `name:${e.agent}`;
    if (/Start/.test(e.event)) open.set(key, e);
    else if (/Stop/.test(e.event)) { if (!open.delete(key)) open.delete(`name:${e.agent}`); }
  }
  const staleMs = 6 * 60 * 60 * 1000; // a start with no stop for 6h is treated as abandoned
  const now = Date.now();
  const active = [...open.values()].filter((e) => now - Date.parse(e.at) < staleMs);
  return { active, recent: events.slice(-40).reverse() };
}

function workOrders() {
  const out = [];
  for (const line of readSafe(WO, 256 * 1024).split(/\r?\n/)) {
    const m = /^\|\s*(WO-\d{3})\s*\|\s*([^|]+?)\s*\|[^|]*\|[^|]*\|\s*([a-z-]+)\s*\|/.exec(line);
    if (m) out.push({ id: m[1], title: m[2].slice(0, 90), status: m[3] });
  }
  return out;
}

function state() {
  return { project: PROJECT, title: TITLE, root: path.basename(ROOT), at: new Date().toISOString(), roster: roster(), ...activity(), workOrders: workOrders() };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TITLE} · Agent View</title>
<style>
:root{--bg:#0f1720;--card:#16212d;--ink:#e6edf3;--mute:#8b9bab;--acc:#3fb68b;--warn:#e3b341;--line:#243243}
@media (prefers-color-scheme: light){:root{--bg:#f6f8fa;--card:#fff;--ink:#1f2328;--mute:#59636e;--acc:#1a7f5a;--warn:#9a6700;--line:#d1d9e0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0}.tag{background:var(--acc);color:#fff;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
main{display:grid;gap:16px;padding:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:0 0 10px}
ul{list-style:none;margin:0;padding:0}li{padding:6px 0;border-bottom:1px solid var(--line)}li:last-child{border:0}
.n{font-weight:600}.m{color:var(--mute);font-size:12px}.on{color:var(--acc);font-weight:700}.st{font-size:12px;padding:1px 8px;border-radius:6px;border:1px solid var(--line)}
.st.review{color:var(--warn)}.st.done{color:var(--acc)}.st.in-progress{color:var(--acc);font-weight:700}
</style></head><body>
<header><h1 id="t">${TITLE}</h1><span class="tag">project: ${PROJECT}</span><span class="m" id="u">connecting…</span></header>
<main>
<section><h2>Working now</h2><ul id="active"></ul></section>
<section><h2>Team</h2><ul id="team"></ul></section>
<section><h2>Recent activity</h2><ul id="recent"></ul></section>
<section><h2>Work orders</h2><ul id="wo"></ul></section>
</main>
<script>
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const fill=(id,items,make,empty)=>{const u=document.getElementById(id);u.replaceChildren();if(!items.length){u.append(el('li','m',empty));return}items.forEach(i=>u.append(make(i)))};
const ago=s=>{const d=Math.max(0,(Date.now()-Date.parse(s))/1000);return d<60?Math.floor(d)+'s ago':d<3600?Math.floor(d/60)+'m ago':Math.floor(d/3600)+'h ago'};
let timer=null;
async function tick(){try{const r=await fetch('/state.json',{cache:'no-store'});const s=await r.json();
 if(s.project!=='${PROJECT}')throw new Error('wrong project');
 fill('active',s.active,a=>{const l=el('li');l.append(el('span','on','▶ '+a.agent),el('span','m','  since '+ago(a.at)));return l},'No agent working right now');
 fill('team',s.roster,a=>{const l=el('li');l.append(el('div','n',(a.lead?'★ ':'')+a.name),el('div','m',a.model+' · '+a.role));return l},'No agents found');
 fill('recent',s.recent,e=>{const l=el('li');l.append(el('span','n',(/Start/.test(e.event)?'▶ ':'■ ')+e.agent),el('span','m','  '+ago(e.at)));return l},'No activity yet');
 fill('wo',s.workOrders,w=>{const l=el('li');l.append(el('span','st '+w.status,w.status),el('span',null,'  '+w.id+' — '+w.title));return l},'No work orders');
 document.getElementById('u').textContent='updated '+new Date().toLocaleTimeString();
}catch(e){document.getElementById('u').textContent='disconnected — is the server running?'}}
function start(){if(!timer){tick();timer=setInterval(tick,3000)}}function stop(){clearInterval(timer);timer=null}
document.addEventListener('visibilitychange',()=>document.hidden?stop():start());start();
</script></body></html>`;

// AGENT_VIEW_TRUST_HOST=1: only for an isolated cloud container whose preview proxy rewrites Host. Never on a desktop.
const TRUST_HOST = process.env.AGENT_VIEW_TRUST_HOST === '1';
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

const server = http.createServer((req, res) => {
  const send = (code, type, body) => {
    res.writeHead(code, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  try {
    if (!TRUST_HOST) {
      if (!HOSTS.has(String(req.headers.host || '').toLowerCase())) return send(403, 'text/plain', 'forbidden host');
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(403, 'text/plain', 'cross-site request refused');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'read-only');
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') return send(200, 'text/html; charset=utf-8', PAGE);
    if (url === '/state.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(state()));
    return send(404, 'text/plain', 'not found');
  } catch (_) {
    try { send(500, 'text/plain', 'error'); } catch (__) { /* socket gone */ }
  }
});
server.on('error', (e) => { process.stderr.write(`agent-view: ${e.code || e.message}\n`); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`agent view (${TITLE}) on http://localhost:${PORT}\n`));
