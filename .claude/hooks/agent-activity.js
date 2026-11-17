#!/usr/bin/env node
'use strict';
/**
 * SubagentStart / SubagentStop / PostToolUse hook — the team's activity record.
 *
 * Appends one tab-separated line per event to .claude/agent-activity.log (gitignored):
 *   <ISO time> TAB <event> TAB <agent> [TAB <agent id> [TAB <tool name>]]
 * Subagent start/stop also show a short notice in the session. Main-thread events (UserPromptSubmit, Stop,
 * PostToolUse without agent_id) are recorded as the lead (eureka-lead) so the view shows the lead working as
 * soon as the owner asks something; they print nothing. PostToolUse records the tool NAME only — never tool
 * input, output, prompt text, paths or commands, so no secret can reach the log.
 * Cross-platform (pure Node, no shell). Never blocks or fails the session: every error is swallowed, exit 0.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * The main checkout of this repository, even when this script runs from a linked git worktree
 * (`.git` is then a file pointing into <main>/.git/worktrees/<name>). Pure fs, no git process.
 * Every session (main folder, worktrees, or the parent folder's hooks) thus shares one activity log.
 */
function mainRoot(dir) {
  try {
    const dotGit = path.join(dir, '.git');
    if (!fs.statSync(dotGit).isFile()) return dir;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return dir;
    const gitDir = path.resolve(dir, m[1].trim());
    const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    return path.basename(common) === '.git' && fs.existsSync(path.join(path.dirname(common), '.claude')) ? path.dirname(common) : dir;
  } catch (_) { return dir; }
}

const LEAD = 'eureka-lead';
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
    // Main thread (no agent_id): the owner's session acts as the lead. A prompt starts the lead's turn,
    // Stop ends it, and its tool calls (e.g. Agent = delegating) are shown as the lead's.
    const lead = !e.agent_id && /^(UserPromptSubmit|Stop|PostToolUse)$/.test(event);
    const sid = clean(e.session_id, 64).replace(/[^A-Za-z0-9-]/g, '').slice(0, 7);
    const agent = lead ? LEAD : clean(e.agent_type || e.subagent_type || e.agent_name || 'agent', 60);
    const id = e.agent_id ? clean(e.agent_id, 8) : lead ? `L${sid || 'main'}` : '';
    const isTool = /ToolUse/.test(event);
    const tool = isTool ? clean(e.tool_name, 80).replace(/[^A-Za-z0-9_.:-]/g, '') : '';
    const isStart = /Start/.test(event);
    const verb = isStart ? 'started' : /Stop/.test(event) ? 'finished' : event;

    // The repo this script lives in (not CLAUDE_PROJECT_DIR, which may be a parent folder or a worktree).
    const root = mainRoot(path.resolve(__dirname, '..', '..'));
    const logFile = path.join(root, '.claude', 'agent-activity.log');
    try {
      try {
        if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
      } catch (_) { /* no log yet */ }
      fs.appendFileSync(logFile, `${new Date().toISOString()}\t${event}\t${agent}${id ? `\t${id}` : ''}${tool ? `\t${tool}` : ''}\n`);
    } catch (_) { /* logging is best effort */ }

    if (!isTool && !lead) process.stdout.write(JSON.stringify({ systemMessage: `${isStart ? '▶' : '■'} ${agent} ${verb}` }));
  } catch (_) { /* never block the session */ }
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { if (raw.length <= MAX_INPUT) raw += c; });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 3000).unref(); // stdin never closed → still exit cleanly
