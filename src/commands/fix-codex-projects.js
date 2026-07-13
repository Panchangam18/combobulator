import fs from 'node:fs';
import path from 'node:path';
import { PATHS, isIgnoredCwd, isMirrorMarker } from '../config.js';
import { info, warn } from '../log.js';
import { registerCodexWorkspaceRoot } from '../codex-registry.js';
import { upsertCodexThread } from '../codex-thread-db.js';

// Walk every Combobulator-mirrored rollout file and ensure it's wired up to
// Codex Desktop's UI: a row in state_5.sqlite's `threads` table (so the chat
// shows in the per-cwd sidebar) AND the cwd in the JSON workspace-roots list
// (belt-and-suspenders for fresh installs). Idempotent.
export async function fixCodexProjects() {
  if (!fs.existsSync(PATHS.codexSessions)) {
    info('no codex sessions directory; nothing to do.');
    return;
  }

  const rollouts = [];
  walk(PATHS.codexSessions, rollouts);

  let mirrorCount = 0;
  let threadsUpserted = 0;
  const cwds = new Set();

  for (const f of rollouts) {
    let meta;
    try {
      meta = peek(f);
    } catch { continue; }
    if (!meta?.isMirror) continue;
    mirrorCount++;

    if (meta.cwd && !isIgnoredCwd(meta.cwd)) cwds.add(meta.cwd);

    if (meta.sessionId && meta.cwd && !isIgnoredCwd(meta.cwd)) {
      const stat = fs.statSync(f);
      const ok = upsertCodexThread({
        sessionId: meta.sessionId,
        rolloutPath: f,
        cwd: meta.cwd,
        title: meta.title || 'Synced from combobulator',
        firstUserMessage: meta.firstUserMessage || '',
        createdAtMs: meta.createdAtMs || stat.birthtimeMs || stat.mtimeMs,
        updatedAtMs: stat.mtimeMs,
      });
      if (ok) threadsUpserted++;
    }
  }

  info(`scanned ${rollouts.length} rollout file(s); ${mirrorCount} are combobulator mirrors.`);
  info(`upserted ${threadsUpserted} thread row(s) into Codex Desktop's DB.`);

  // Register each cwd as a Codex Desktop workspace root via `codex app <path>`.
  // This is what makes the project appear in Codex's sidebar persistently.
  // Note: each call may briefly steal focus to Codex Desktop as it switches
  // to the registered workspace. Cwds already in workspace-roots are skipped.
  let registered = 0;
  for (const cwd of cwds) {
    if (await registerCodexWorkspaceRoot(cwd)) registered++;
  }
  if (registered) {
    info(`registered ${registered} new Codex Desktop workspace root(s).`);
  } else if (cwds.size) {
    info(`all ${cwds.size} cwd(s) were already registered with Codex Desktop.`);
  }
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.startsWith('rollout-')) {
      out.push(full);
    }
  }
}

// Read the first few lines of a rollout to detect if it's our mirror and
// pull out the metadata we stuffed in the marker line + session_meta payload.
// For older mirrors that didn't store title/firstUserMessage in the marker,
// fall back to parsing the flattened transcript on line 3 (the response_item
// user message) for the first **User:** chunk.
function peek(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    // Read enough to capture the marker + session_meta + (often) the flattened
    // transcript. 64KB is plenty for a small chat; long chats truncate and we
    // just fall back to the generic title.
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    let isMirror = false;
    let cwd = null;
    let sessionId = null;
    let title = null;
    let firstUserMessage = null;
    let createdAtMs = null;
    let flattenedText = null;
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i];
      if (!line) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      // Legacy top-level marker (pre-v0.2 rollouts)
      if (isMirrorMarker(d)) {
        isMirror = true;
        if (d.title) title = d.title;
        if (d.firstUserMessage) firstUserMessage = d.firstUserMessage;
        if (d.cwd && !cwd) cwd = d.cwd;
      }
      if (d.type === 'session_meta') {
        if (d.payload?.originator === 'combobulate') isMirror = true;
        if (d.payload?.cwd) cwd = d.payload.cwd;
        if (d.payload?.id) sessionId = d.payload.id;
        if (d.payload?.timestamp) createdAtMs = Date.parse(d.payload.timestamp);
        // Markers are nested in the current combobulator metadata object;
        // retain the legacy location for pre-rename rollout files.
        const c = d.payload?.combobulator || d.payload?.combobulate;
        if (isMirrorMarker(c)) {
          isMirror = true;
          if (c.title && !title) title = c.title;
          if (c.firstUserMessage && !firstUserMessage) firstUserMessage = c.firstUserMessage;
        }
      }
      if (d.type === 'response_item' && d.payload?.role === 'user' && d.payload?.content?.[0]?.text) {
        flattenedText = d.payload.content[0].text;
      }
    }
    if (isMirror && (!title || !firstUserMessage) && flattenedText) {
      const extracted = extractFirstUserLine(flattenedText);
      if (extracted) {
        if (!firstUserMessage) firstUserMessage = extracted.slice(0, 2000);
        if (!title || title === 'Synced from combobulator') title = extracted.split('\n')[0].slice(0, 200);
      }
    }
    return { isMirror, cwd, sessionId, title, firstUserMessage, createdAtMs };
  } finally {
    fs.closeSync(fd);
  }
}

// The flattened transcript looks like:
//   [Synced from claude via combobulator]
//   ... header ...
//   ---
//   **User:** <first message body — may span multiple lines until the next \n\n>
//
//   **Assistant:** ...
// Iterate every **User:** chunk and return the first that looks like a real
// human prompt — not a tool result, not an IDE injection.
function extractFirstUserLine(text) {
  const re = /\*\*User:\*\*\s+([\s\S]*?)(?=\n\n\*\*(?:User|Assistant):\*\*|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    if (!body) continue;
    if (/^\[tool result\]/i.test(body)) continue;
    if (/^<(ide_opened_file|system-reminder|command-(name|message)|environment_context)\b/i.test(body)) continue;
    if (/^\[Pasted text/.test(body)) continue;
    return body;
  }
  return null;
}
