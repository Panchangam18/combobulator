import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PATHS, MIRROR_MARKER } from '../config.js';

// Walk ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl recursively.
export function listCodexSessions() {
  const root = PATHS.codexSessions;
  if (!fs.existsSync(root)) return [];
  const out = [];
  walk(root, out);
  return out.sort((a, b) => b.mtime - a.mtime);
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.startsWith('rollout-')) {
      try {
        const s = fs.statSync(full);
        out.push({ path: full, mtime: s.mtimeMs });
      } catch {}
    }
  }
}

export async function readCodexSession(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream });

  const messages = [];
  let sessionId = null;
  let cwd = null;
  let createdAt = null;
  let updatedAt = null;
  let isMirror = false;
  let threadName = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    // Old top-level marker (legacy rollout format) — still detect for cleanup
    if (d[MIRROR_MARKER]) { isMirror = true; continue; }

    if (d.timestamp) {
      const t = Date.parse(d.timestamp);
      if (Number.isFinite(t)) {
        if (createdAt === null) createdAt = t;
        updatedAt = t;
      }
    }

    if (d.type === 'session_meta') {
      if (d.payload?.id) sessionId = d.payload.id;
      if (d.payload?.cwd) cwd = d.payload.cwd;
      // Detect new and legacy marker locations.
      if (d.payload?.originator === 'combobulate') isMirror = true;
      if (d.payload?.combobulate?.[MIRROR_MARKER]) isMirror = true;
    } else if (d.type === 'event_msg') {
      const p = d.payload;
      if (p?.type === 'user_message' && typeof p.message === 'string') {
        messages.push({ role: 'user', text: p.message.trim(), ts: Date.parse(d.timestamp) || Date.now() });
      } else if (p?.type === 'agent_message' && typeof p.message === 'string') {
        messages.push({ role: 'assistant', text: p.message.trim(), ts: Date.parse(d.timestamp) || Date.now() });
      } else if (p?.type === 'thread_name_updated' && p.thread_name) {
        threadName = p.thread_name;
      }
    }
  }

  // Filter out the auto-injected <environment_context> prelude — first user message
  // is almost always the env block. We keep only "real" user text.
  const filtered = messages.filter(
    (m, i) => !(i === 0 && m.role === 'user' && m.text.startsWith('<environment_context>'))
  );

  return {
    source: 'codex',
    sessionId: sessionId || path.basename(filePath, '.jsonl'),
    cwd,
    threadName,
    createdAt: createdAt ?? Date.now(),
    updatedAt: updatedAt ?? Date.now(),
    messages: filtered,
    isMirror,
    sourcePath: filePath,
  };
}
