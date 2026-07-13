import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PATHS, isMirrorMarker } from '../config.js';

// Walk ~/.claude/projects/*/{sessionId}.jsonl. Return [{path, mtime}] sorted newest first.
export function listClaudeSessions() {
  if (!fs.existsSync(PATHS.claudeProjects)) return [];
  const out = [];
  for (const projDir of fs.readdirSync(PATHS.claudeProjects)) {
    const full = path.join(PATHS.claudeProjects, projDir);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(full, f);
      try {
        const s = fs.statSync(fp);
        out.push({ path: fp, mtime: s.mtimeMs, size: s.size, projDir });
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Read a Claude session and emit a typed event stream that the codex sink can
// translate into native function_call / custom_tool_call events.
//
// Event kinds:
//   {kind: 'user', text, ts}         — real human prompt
//   {kind: 'assistant', text, ts}    — assistant natural-language reply
//   {kind: 'tool_call', tool, input, callId, ts} — assistant tool invocation
//   {kind: 'tool_result', callId, output, isError, ts} — paired tool response
//
// Tool calls and tool results are matched by Claude's tool_use_id, so the sink
// can render them as the proper Codex events with matching call_id.
export async function readClaudeSession(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream });

  const events = [];
  let sessionId = path.basename(filePath, '.jsonl');
  let cwd = null;
  let createdAt = null;
  let updatedAt = null;
  let isMirror = false;
  let threadName = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    if (isMirrorMarker(d)) { isMirror = true; continue; }

    if (d.sessionId && !sessionId) sessionId = d.sessionId;
    if (d.cwd && !cwd) cwd = d.cwd;
    if (d.timestamp) {
      const t = Date.parse(d.timestamp);
      if (Number.isFinite(t)) {
        if (createdAt === null) createdAt = t;
        updatedAt = t;
      }
    }

    if (d.type === 'ai-title' && d.aiTitle) {
      threadName = d.aiTitle;
      continue;
    }

    const ts = Date.parse(d.timestamp) || Date.now();

    if (d.type === 'user' && d.message?.role === 'user') {
      // Walk content blocks. A Claude user message can be a mix of plain text
      // (real prompt) and tool_result blocks (responses to prior tool calls).
      // Emit each as its own event so the sink can interleave them correctly.
      const content = d.message.content;
      if (typeof content === 'string') {
        const t = content.trim();
        if (t) events.push({ kind: 'user', text: t, ts });
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'text' && c.text) {
            events.push({ kind: 'user', text: c.text, ts });
          } else if (c?.type === 'tool_result') {
            const output = typeof c.content === 'string'
              ? c.content
              : Array.isArray(c.content)
                ? c.content.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n')
                : '';
            events.push({
              kind: 'tool_result',
              callId: c.tool_use_id,
              output,
              isError: !!c.is_error,
              ts,
            });
          }
        }
      }
    } else if (d.type === 'assistant' && d.message?.role === 'assistant') {
      const content = d.message.content;
      if (typeof content === 'string') {
        const t = content.trim();
        if (t) events.push({ kind: 'assistant', text: t, ts });
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'text' && c.text) {
            events.push({ kind: 'assistant', text: c.text, ts });
          } else if (c?.type === 'tool_use') {
            events.push({
              kind: 'tool_call',
              tool: c.name,
              input: c.input,
              callId: c.id,
              ts,
            });
          }
          // Skip 'thinking' blocks — internal monologue, not for rendering.
        }
      }
    }
  }

  // Back-compat: also derive a flat "messages" list (user text + assistant text)
  // for any code that still expects the old shape (claude sink, title extraction).
  const messages = events
    .filter((e) => e.kind === 'user' || e.kind === 'assistant')
    .map((e) => ({ role: e.kind, text: e.text, ts: e.ts }));

  return {
    source: 'claude',
    sessionId,
    cwd,
    threadName,
    createdAt: createdAt ?? Date.now(),
    updatedAt: updatedAt ?? Date.now(),
    events,
    messages,
    isMirror,
    sourcePath: filePath,
  };
}
