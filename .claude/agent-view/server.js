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
    }).sort((a, b) => Number(b.lead) - Number(a.lead)); // lead first, rest alphabetical (stable sort)
  } catch (_) { return []; }
}

const DONE_MS = 30 * 60 * 1000; // a finished agent shows as "done" for 30 min, then idle
const STALE_MS = 6 * 60 * 60 * 1000; // a start with no stop for 6h is treated as abandoned
const MAX_FEED = 200;
const KINDS = { SubagentStart: 'start', SubagentStop: 'stop', PostToolUse: 'tool' };
const safe = (v, max) => String(v || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max);

function activity(team) {
  const lines = readSafe(LOG, MAX_LOG_TAIL).split(/\r?\n/).filter(Boolean);
  const events = [];
  const names = new Map(); // agent id → agent type (stop/tool events may only carry the id)
  for (const line of lines) {
    const [at, event, agentRaw, idRaw, toolRaw] = line.split('\t');
    const kind = KINDS[event] || (/Start/.test(event || '') ? 'start' : /Stop/.test(event || '') ? 'stop' : null);
    if (!at || !kind || Number.isNaN(Date.parse(at))) continue;
    const id = safe(idRaw, 16);
    let agent = safe(agentRaw, 60) || 'agent';
    if (kind === 'start' && id) names.set(id, agent);
    else if (agent === 'agent' && names.has(id)) agent = names.get(id);
    events.push({ at, kind, agent, id, tool: kind === 'tool' ? safe(toolRaw, 80) : '' });
  }
  // Replay: open runs are agents working now (matched by id, else by agent name).
  const runs = new Map();
  const finished = new Map();
  for (const e of events) {
    const key = e.id || `name:${e.agent}`;
    if (e.kind === 'start') runs.set(key, { agent: e.agent, id: e.id, at: e.at, tools: 0, lastTool: '', lastAt: e.at });
    else if (e.kind === 'tool') { const r = runs.get(key); if (r) { r.tools += 1; r.lastTool = e.tool; r.lastAt = e.at; } }
    else {
      const k = runs.has(key) ? key : `name:${e.agent}`;
      const r = runs.get(k);
      runs.delete(k);
      finished.set(e.agent, { at: e.at, tools: r ? r.tools : 0, startedAt: r ? r.at : null });
    }
  }
  const now = Date.now();
  const active = [...runs.values()].filter((r) => now - Date.parse(r.at) < STALE_MS);
  const known = new Set(team.map((a) => a.name));
  const guests = [...new Set(active.map((r) => r.agent))].filter((n) => !known.has(n))
    .map((name) => ({ name, model: 'session', lead: false, role: 'Built-in or ad-hoc agent', guest: true }));
  const agents = [...team, ...guests].map((a) => {
    const mine = active.filter((r) => r.agent === a.name).sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
    const fin = finished.get(a.name);
    if (mine.length) return { ...a, status: 'working', since: mine[0].at, runs: mine.length, tools: mine[0].tools, lastTool: mine[0].lastTool };
    if (fin && now - Date.parse(fin.at) < DONE_MS) return { ...a, status: 'done', since: fin.at, tools: fin.tools };
    return { ...a, status: 'idle', since: fin ? fin.at : null };
  });
  return { agents, active, recent: events.filter((e) => e.kind !== 'tool').slice(-40).reverse(), log: events.slice(-MAX_FEED) };
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
  const team = roster();
  return { project: PROJECT, title: TITLE, root: path.basename(ROOT), at: new Date().toISOString(), roster: team, ...activity(team), workOrders: workOrders() };
}

// Client page. Written without backticks, "${" or backslashes so it can live inside this template literal.
// Robot SVGs are built only from the constant ROLES table below; every log/agent value is set with textContent.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TITLE} · Agent View</title>
<style>
:root{--bg:#0d141c;--card:#141e29;--card2:#1a2633;--ink:#e6edf3;--mute:#8b9bab;--acc:#3fb68b;--warn:#e3b341;--line:#243243;--eye:#7ff3ff;--eyeoff:#3a4a5a;--metal:#c9d3dd;--metal2:#8996a3}
@media (prefers-color-scheme: light){:root{--bg:#f3f6f9;--card:#fff;--card2:#f6f8fa;--ink:#1f2328;--mute:#59636e;--acc:#1a7f5a;--warn:#9a6700;--line:#d1d9e0;--eye:#00a6c7;--eyeoff:#b5c0cb;--metal:#e3e9ef;--metal2:#9aa6b2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;gap:10px 14px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0}.tag{background:var(--acc);color:#fff;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
.counts{display:flex;gap:8px;flex-wrap:wrap}.cnt{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:2px 10px;color:var(--mute)}
.cnt b{color:var(--ink)}.cnt.w b{color:var(--eye)}.cnt.d b{color:var(--acc)}
.m{color:var(--mute);font-size:12px}#u{margin-left:auto}
main{display:grid;gap:16px;padding:16px;grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
@media (max-width:860px){main{grid-template-columns:minmax(0,1fr)}}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;min-width:0}.full{grid-column:1/-1}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:0 0 12px;display:flex;align-items:center;gap:8px}
.floor{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.bot{position:relative;background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:10px 10px 12px;text-align:center;transition:border-color .3s,box-shadow .3s,opacity .3s}
.bot svg{width:88px;height:96px;display:block;margin:0 auto 4px;overflow:visible}
.bot .n{font-weight:650;font-size:13px;word-break:break-word}.bot .r{color:var(--mute);font-size:11px;min-height:15px}
.pill{display:inline-block;margin-top:6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:1px 9px;border:1px solid var(--line);color:var(--mute)}
.bot .x{font-size:11px;color:var(--mute);margin-top:4px;min-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.eye{fill:var(--eyeoff);transition:fill .3s}
.bot.working{border-color:var(--role);box-shadow:0 0 0 1px var(--role),0 6px 22px -8px var(--role)}
.bot.working .pill{color:var(--eye);border-color:var(--eye)}.bot.working .eye{fill:var(--eye)}
.bot.working .rig{animation:bob 1.4s ease-in-out infinite}.bot.working .bulb{animation:blink 1s steps(2,start) infinite}
.bot.working .arm-r{transform-origin:76px 66px;animation:wave 1.4s ease-in-out infinite}
.bot.done .pill{color:var(--acc);border-color:var(--acc)}.bot.done .eye{fill:var(--acc)}
.bot.done::after{content:'✓';position:absolute;top:8px;right:10px;width:20px;height:20px;border-radius:50%;background:var(--acc);color:#fff;font-size:12px;line-height:20px;font-weight:800}
.bot.idle{opacity:.72}.bot.idle svg{filter:grayscale(.75)}.bot.idle .eye{transform:scaleY(.3);transform-box:fill-box;transform-origin:center}
.bot .zz{display:none}.bot.idle .zz{display:inline;animation:float 3s ease-in-out infinite}
.bot.lead .n::before{content:'★ ';color:#f2b134}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes blink{to{opacity:.25}}@keyframes wave{0%,100%{transform:rotate(0)}50%{transform:rotate(-14deg)}}
@keyframes float{0%,100%{transform:translateY(0);opacity:.5}50%{transform:translateY(-4px);opacity:1}}
@keyframes flash{from{background:color-mix(in srgb,var(--eye) 18%,transparent)}to{background:transparent}}
.bar{display:flex;gap:6px;flex-wrap:wrap;margin:-4px 0 10px}
.bar button{font:inherit;font-size:12px;background:transparent;color:var(--mute);border:1px solid var(--line);border-radius:999px;padding:2px 10px;cursor:pointer}
.bar button[aria-pressed=true]{color:var(--ink);border-color:var(--ink)}.bar .sp{flex:1}
.log{height:360px;overflow-y:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:6px 0}
.row{display:grid;grid-template-columns:72px 18px minmax(0,1fr);gap:6px;padding:1px 10px;align-items:baseline}
.row.new{animation:flash 1.6s ease-out}.row .t{color:var(--mute)}.row .k{text-align:center;font-weight:800}
.row .a{font-weight:700}.row .msg{overflow-wrap:anywhere}.row.start .k{color:var(--eye)}.row.stop .k{color:var(--acc)}.row.tool .k{color:var(--mute)}
.row .tl{border:1px solid var(--line);border-radius:4px;padding:0 5px}
.empty{color:var(--mute);padding:10px;font-family:system-ui,sans-serif}
#follow{display:none}#follow.show{display:inline-block;color:var(--eye);border-color:var(--eye)}
ul{list-style:none;margin:0;padding:0}li{padding:6px 0;border-bottom:1px solid var(--line)}li:last-child{border:0}
.st{font-size:12px;padding:1px 8px;border-radius:6px;border:1px solid var(--line)}.st.review{color:var(--warn)}.st.done{color:var(--acc)}.st.in-progress{color:var(--acc);font-weight:700}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<header><h1>${TITLE}</h1><span class="tag">project: ${PROJECT}</span>
<span class="counts"><span class="cnt w"><b id="cw">0</b> working</span><span class="cnt d"><b id="cd">0</b> done</span><span class="cnt"><b id="ci">0</b> idle</span></span>
<span class="m" id="u">connecting…</span></header>
<main>
<section class="full"><h2>Working now</h2><div class="floor" id="floor"></div></section>
<section><h2>Logs</h2>
<div class="bar" id="filters"><button data-f="all" aria-pressed="true">All</button><button data-f="start" aria-pressed="false">Starts</button><button data-f="tool" aria-pressed="false">Tool use</button><button data-f="stop" aria-pressed="false">Finishes</button><span class="sp"></span><button id="follow" aria-pressed="false">↓ Jump to latest</button></div>
<div class="log" id="log" role="log" aria-live="polite" aria-label="Agent activity log"></div></section>
<section><h2>Work orders</h2><ul id="wo"></ul></section>
</main>
<script>
var ROLES={
 'eureka-lead':{c:'#f2b134',h:'sq',e:'visor',top:'crown',i:'star',l:'Lead · orchestrator'},
 'core-engineer':{c:'#4f8cff',h:'sq',e:'dots',top:'ant',i:'gear',l:'Core engine'},
 'integrations-engineer':{c:'#1fb5c9',h:'rd',e:'dots',top:'ant2',i:'plug',l:'Express & CLI'},
 'rule-analyst':{c:'#9b6dff',h:'dome',e:'mono',top:'ant',i:'lens',l:'Rule specs'},
 'qa-engineer':{c:'#3fb68b',h:'rd',e:'goggles',top:'ant',i:'check',l:'QA · verifier'},
 'security-reviewer':{c:'#e5534b',h:'sq',e:'visor',top:'crest',i:'shield',l:'Security review'},
 'security-tester':{c:'#ff7b3d',h:'dome',e:'mono',top:'ant2',i:'bolt',l:'Security testing'},
 'devops-release':{c:'#d36ac2',h:'rd',e:'visor',top:'ant',i:'rocket',l:'Build & release'},
 'docs-community':{c:'#c08a4a',h:'dome',e:'dots',top:'ant',i:'quill',l:'Docs & community'}
};
var DEF={c:'#8b9bab',h:'rd',e:'dots',top:'ant',i:'none',l:''};
var role=function(n){return ROLES[n]||DEF};
function head(r){var c=r.c,s='';
 if(r.top==='crown')s+='<path d="M36 18 L40 8 L45 15 L50 6 L55 15 L60 8 L64 18 Z" fill="#f2b134" stroke="#b8801a" stroke-width="1.2"/>';
 else if(r.top==='crest')s+='<path d="M40 18 Q50 0 60 18 Z" fill="'+c+'" opacity=".85"/><rect x="48" y="6" width="4" height="12" rx="2" fill="var(--metal2)"/>';
 else if(r.top==='ant2')s+='<line x1="38" y1="18" x2="32" y2="6" stroke="var(--metal2)" stroke-width="2.5"/><line x1="62" y1="18" x2="68" y2="6" stroke="var(--metal2)" stroke-width="2.5"/><circle class="bulb" cx="32" cy="6" r="3.5" fill="'+c+'"/><circle class="bulb" cx="68" cy="6" r="3.5" fill="'+c+'"/>';
 else s+='<line x1="50" y1="18" x2="50" y2="6" stroke="var(--metal2)" stroke-width="2.5"/><circle class="bulb" cx="50" cy="5" r="4" fill="'+c+'"/>';
 if(r.h==='dome')s+='<path d="M28 44 Q28 16 50 16 Q72 16 72 44 Z" fill="var(--metal)" stroke="'+c+'" stroke-width="3"/>';
 else s+='<rect x="28" y="17" width="44" height="28" rx="'+(r.h==='sq'?5:13)+'" fill="var(--metal)" stroke="'+c+'" stroke-width="3"/>';
 s+='<rect x="22" y="26" width="6" height="10" rx="2" fill="'+c+'"/><rect x="72" y="26" width="6" height="10" rx="2" fill="'+c+'"/>';
 if(r.e==='visor')s+='<rect x="34" y="25" width="32" height="10" rx="5" fill="#1b2632"/><rect class="eye" x="37" y="27" width="26" height="6" rx="3"/>';
 else if(r.e==='mono')s+='<circle cx="50" cy="31" r="8" fill="#1b2632"/><circle class="eye" cx="50" cy="31" r="5"/>';
 else if(r.e==='goggles')s+='<circle cx="41" cy="30" r="7" fill="#1b2632" stroke="'+c+'" stroke-width="2"/><circle cx="59" cy="30" r="7" fill="#1b2632" stroke="'+c+'" stroke-width="2"/><circle class="eye" cx="41" cy="30" r="3.5"/><circle class="eye" cx="59" cy="30" r="3.5"/>';
 else s+='<circle class="eye" cx="41" cy="30" r="4.5"/><circle class="eye" cx="59" cy="30" r="4.5"/>';
 s+='<rect x="43" y="38" width="14" height="3" rx="1.5" fill="var(--metal2)"/>';
 return s}
function icon(k){var w='#fff';switch(k){
 case 'star':return '<path d="M50 63 L53 70 L60 70 L54.5 74.5 L57 82 L50 77.5 L43 82 L45.5 74.5 L40 70 L47 70 Z" fill="'+w+'"/>';
 case 'gear':return '<circle cx="50" cy="72" r="7.5" fill="none" stroke="'+w+'" stroke-width="4" stroke-dasharray="3 2.9"/><circle cx="50" cy="72" r="3" fill="'+w+'"/>';
 case 'plug':return '<rect x="44" y="70" width="12" height="9" rx="2" fill="'+w+'"/><rect x="46" y="64" width="2.5" height="6" fill="'+w+'"/><rect x="51.5" y="64" width="2.5" height="6" fill="'+w+'"/><rect x="48.5" y="79" width="3" height="4" fill="'+w+'"/>';
 case 'lens':return '<circle cx="48" cy="70" r="6" fill="none" stroke="'+w+'" stroke-width="2.6"/><line x1="52.5" y1="74.5" x2="58" y2="80" stroke="'+w+'" stroke-width="3" stroke-linecap="round"/>';
 case 'check':return '<path d="M42 72 L48 78 L59 66" fill="none" stroke="'+w+'" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>';
 case 'shield':return '<path d="M50 62 L59 65.5 Q59 77 50 82 Q41 77 41 65.5 Z" fill="'+w+'"/>';
 case 'bolt':return '<path d="M53 62 L43 74 L50 74 L47 83 L58 70 L51 70 Z" fill="'+w+'"/>';
 case 'rocket':return '<path d="M50 61 Q56 67 55 77 L45 77 Q44 67 50 61 Z" fill="'+w+'"/><path d="M45 74 L41 80 L45 79 Z M55 74 L59 80 L55 79 Z" fill="'+w+'"/><circle cx="50" cy="69" r="2" fill="#1b2632"/>';
 case 'quill':return '<path d="M58 62 Q46 64 43 80 L45 81 Q50 70 58 62 Z" fill="'+w+'"/><line x1="43" y1="80" x2="41" y2="84" stroke="'+w+'" stroke-width="2"/>';
 default:return '<circle cx="50" cy="72" r="4" fill="'+w+'"/>'}}
function robot(r){return '<svg viewBox="0 0 100 110" aria-hidden="true"><ellipse cx="50" cy="106" rx="26" ry="3.5" fill="#000" opacity=".18"/><g class="rig">'+head(r)+
 '<rect x="45" y="45" width="10" height="6" fill="var(--metal2)"/>'+
 '<rect x="16" y="56" width="10" height="24" rx="5" fill="var(--metal)" stroke="var(--metal2)" stroke-width="1.5"/>'+
 '<g class="arm-r"><rect x="74" y="56" width="10" height="24" rx="5" fill="var(--metal)" stroke="var(--metal2)" stroke-width="1.5"/></g>'+
 '<rect x="26" y="51" width="48" height="40" rx="9" fill="var(--metal)" stroke="'+r.c+'" stroke-width="3"/>'+
 '<rect x="37" y="59" width="26" height="26" rx="6" fill="'+r.c+'"/>'+icon(r.i)+
 '<rect x="34" y="91" width="10" height="11" rx="3" fill="var(--metal2)"/><rect x="56" y="91" width="10" height="11" rx="3" fill="var(--metal2)"/>'+
 '</g><text class="zz" x="76" y="14" font-size="12" font-weight="700" fill="var(--mute)">z z</text></svg>'}
var el=function(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
var ago=function(s){var d=Math.max(0,(Date.now()-Date.parse(s))/1000);return d<60?Math.floor(d)+'s':d<3600?Math.floor(d/60)+'m':d<86400?Math.floor(d/3600)+'h':Math.floor(d/86400)+'d'};
var hms=function(s){var d=new Date(s);return isNaN(d)?'':d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})};
var cards={};
function floor(agents){var f=document.getElementById('floor'),seen={},n={working:0,done:0,idle:0};
 agents.forEach(function(a){var c=cards[a.name];seen[a.name]=1;n[a.status]=(n[a.status]||0)+1;var r=role(a.name);
  if(!c){c=el('div','bot');c.style.setProperty('--role',r.c);c.innerHTML=robot(r);
   c.append(el('div','n',a.name),el('div','r',r.l||a.role||''),el('div',''),el('div','x'));c.children[3].append(el('span','pill'));
   cards[a.name]=c;f.append(c)}
  c.className='bot '+a.status+(a.lead?' lead':'');c.title=a.role||'';
  c.querySelector('.pill').textContent=a.status;
  var x=a.status==='working'?((a.lastTool?a.lastTool+' · ':'')+(a.tools||0)+' tools · '+ago(a.since)+(a.runs>1?' · ×'+a.runs:''))
   :a.status==='done'?('finished '+ago(a.since)+' ago'+(a.tools?' · '+a.tools+' tools':''))
   :(a.since?'last run '+ago(a.since)+' ago':'not run yet');
  c.querySelector('.x').textContent=x;c.setAttribute('aria-label',a.name+': '+a.status+', '+x)});
 Object.keys(cards).forEach(function(k){if(!seen[k]){cards[k].remove();delete cards[k]}});
 document.getElementById('cw').textContent=n.working;document.getElementById('cd').textContent=n.done;document.getElementById('ci').textContent=n.idle}
var filter='all',lastKey='',logData=[],follow=true;
var logEl=document.getElementById('log'),followBtn=document.getElementById('follow');
var keyOf=function(e){return e.at+'|'+e.kind+'|'+e.id+'|'+e.tool};
function renderLog(){var atEnd=follow,prev=lastKey,mark=!!prev,rows=logData.filter(function(e){return filter==='all'||e.kind===filter});
 logEl.replaceChildren();if(!rows.length){logEl.append(el('div','empty','No activity yet — events appear here as agents start, use tools and finish.'));return}
 var newer=false;rows.forEach(function(e){if(!prev)newer=false;
  var row=el('div','row '+e.kind);row.append(el('span','t',hms(e.at)),el('span','k',e.kind==='start'?'▶':e.kind==='stop'?'■':'·'));
  var m=el('span','msg'),a=el('span','a',e.agent);a.style.color=role(e.agent).c;m.append(a);
  if(e.kind==='tool'){m.append(document.createTextNode(' used '),el('span','tl',e.tool||'a tool'))}else m.append(document.createTextNode(e.kind==='start'?' started':' finished'));
  if(e.id)m.append(el('span','m','  #'+e.id));row.append(m);if(newer)row.classList.add('new');if(mark&&keyOf(e)===prev)newer=true;logEl.append(row)});
 if(atEnd)logEl.scrollTop=logEl.scrollHeight}
logEl.addEventListener('scroll',function(){follow=logEl.scrollHeight-logEl.scrollTop-logEl.clientHeight<24;followBtn.classList.toggle('show',!follow)});
followBtn.addEventListener('click',function(){follow=true;logEl.scrollTop=logEl.scrollHeight;followBtn.classList.remove('show')});
document.getElementById('filters').addEventListener('click',function(ev){var b=ev.target.closest('button[data-f]');if(!b)return;filter=b.dataset.f;
 document.querySelectorAll('#filters button[data-f]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});follow=true;lastKey='';renderLog();if(logData.length)lastKey=keyOf(logData[logData.length-1])});
function wo(items){var u=document.getElementById('wo');u.replaceChildren();if(!items.length){u.append(el('li','m','No work orders'));return}
 items.forEach(function(w){var l=el('li');l.append(el('span','st '+w.status,w.status),el('span',null,'  '+w.id+' — '+w.title));u.append(l)})}
var timer=null;
async function tick(){try{var r=await fetch('/state.json',{cache:'no-store'});var s=await r.json();
 if(s.project!=='${PROJECT}')throw new Error('wrong project');
 floor(s.agents||[]);wo(s.workOrders||[]);
 var log=s.log||[],k=log.length?keyOf(log[log.length-1]):'';if(k!==lastKey||!logEl.childElementCount){logData=log;renderLog();lastKey=k}
 document.getElementById('u').textContent='live · updated '+new Date().toLocaleTimeString();
}catch(e){document.getElementById('u').textContent='disconnected — is the server running?'}}
function start(){if(!timer){tick();timer=setInterval(tick,2000)}}function stop(){clearInterval(timer);timer=null}
document.addEventListener('visibilitychange',function(){document.hidden?stop():start()});start();
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
      // Allow a top-level page load from a link (e.g. clicked in chat/GitHub): the other site cannot read
      // the response and frame-ancestors 'none' blocks framing. Cross-site fetches (state.json) stay refused.
      const topNav = req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (site && site !== 'same-origin' && site !== 'none' && !topNav) return send(403, 'text/plain', 'cross-site request refused');
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
