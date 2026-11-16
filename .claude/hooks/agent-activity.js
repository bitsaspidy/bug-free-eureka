#!/usr/bin/env node
'use strict';
/**
 * SubagentStart / SubagentStop / PostToolUse hook — the team's activity record.
 *
 * Appends one tab-separated line per event to .claude/agent-activity.log (gitignored):
 *   <ISO time> TAB <event> TAB <agent> [TAB <agent id> [TAB <tool name>]]
 * Start/stop also show a short notice in the session. PostToolUse is logged only when it fires inside a
 * subagent (agent_id present) and records the tool NAME only — never tool input, output, paths or commands,
 * so no secret can reach the log. It prints nothing, to keep the session quiet.
 * Cross-platform (pure Node, no shell). Never blocks or fails the session: every error is swallowed, exit 0.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_INPUT = 1024 * 1024; // ignore absurdly large payloads
const MAX_LOG_BYTES = 512 * 1024; // rotate the log once it grows past this

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').slice(0, max);
}

let raw = '';
let done = false;

function finish() {
  if (done) return;
  done = true;
  try {
    let e = {};
    try { e = raw.length <= MAX_INPUT ? JSON.parse(raw || '{}') : {}; } catch (_) { e = {}; }
    const event = clean(e.hook_event_name || process.argv[2] || 'SubagentEvent', 40);
    const agent = clean(e.agent_type || e.subagent_type || e.agent_name || 'agent', 60);
    const id = e.agent_id ? clean(e.agent_id, 8) : '';
    const isTool = /ToolUse/.test(event);
    if (isTool && !id) { done = true; return process.exit(0); } // main-thread tool call: not team activity
    const tool = isTool ? clean(e.tool_name, 80).replace(/[^A-Za-z0-9_.:-]/g, '') : '';
    const isStart = /Start/.test(event);
    const verb = isStart ? 'started' : /Stop/.test(event) ? 'finished' : event;

    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const logFile = path.join(root, '.claude', 'agent-activity.log');
    try {
      try {
        if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
      } catch (_) { /* no log yet */ }
      fs.appendFileSync(logFile, `${new Date().toISOString()}\t${event}\t${agent}${id ? `\t${id}` : ''}${tool ? `\t${tool}` : ''}\n`);
    } catch (_) { /* logging is best effort */ }

    if (!isTool) process.stdout.write(JSON.stringify({ systemMessage: `${isStart ? '▶' : '■'} ${agent} ${verb}` }));
  } catch (_) { /* never block the session */ }
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { if (raw.length <= MAX_INPUT) raw += c; });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 3000).unref(); // stdin never closed → still exit cleanly
