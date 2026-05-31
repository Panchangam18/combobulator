import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { PATHS } from '../config.js';

const execFileP = promisify(execFile);

// Query Cursor's sqlite db read-only. We use the system `sqlite3` CLI with `mode=ro`
// so we never hold a write lock against Cursor's running process.
async function sqlite(query) {
  if (!fs.existsSync(PATHS.cursorDb)) return [];
  // Use file: URI with mode=ro for read-only opening; immutable=1 avoids touching the journal.
  const uri = `file:${PATHS.cursorDb}?mode=ro&immutable=1`;
  const { stdout } = await execFileP('sqlite3', ['-json', uri, query], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!stdout.trim()) return [];
  try { return JSON.parse(stdout); } catch { return []; }
}

// List Cursor composers (chats) sorted newest-first by lastUpdatedAt.
export async function listCursorComposers() {
  const rows = await sqlite(
    `SELECT key,
            json_extract(value, '$.composerId') as id,
            json_extract(value, '$.name') as name,
            json_extract(value, '$.lastUpdatedAt') as updatedAt,
            json_extract(value, '$.createdAt') as createdAt
       FROM cursorDiskKV
      WHERE key LIKE 'composerData:%'
      ORDER BY updatedAt DESC NULLS LAST
      LIMIT 200;`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: Number(r.createdAt) || 0,
    updatedAt: Number(r.updatedAt) || 0,
  }));
}

// Read one composer + all its bubbles, return UnifiedSession.
export async function readCursorComposer(composerId) {
  const headerRows = await sqlite(
    `SELECT value FROM cursorDiskKV WHERE key = 'composerData:${composerId}' LIMIT 1;`
  );
  if (!headerRows.length) return null;

  let header;
  try { header = JSON.parse(headerRows[0].value); } catch { return null; }

  const bubbleOrder = (header.fullConversationHeadersOnly || []).map((h) => h.bubbleId);
  if (!bubbleOrder.length) {
    return {
      source: 'cursor',
      sessionId: composerId,
      cwd: null,
      threadName: header.name || null,
      createdAt: Number(header.createdAt) || Date.now(),
      updatedAt: Number(header.lastUpdatedAt) || Date.now(),
      messages: [],
      isMirror: false,
      sourcePath: `cursor:${composerId}`,
    };
  }

  // Pull all bubbles for this composer in one query.
  const bubbleRows = await sqlite(
    `SELECT substr(key, ${('bubbleId:' + composerId + ':').length + 1}) as bid,
            json_extract(value, '$.type') as bt,
            json_extract(value, '$.text') as text,
            json_extract(value, '$.richText') as richText
       FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:${composerId}:%';`
  );

  const byId = new Map();
  for (const r of bubbleRows) byId.set(r.bid, r);

  const messages = [];
  for (const bid of bubbleOrder) {
    const b = byId.get(bid);
    if (!b) continue;
    const role = b.bt === 1 ? 'user' : b.bt === 2 ? 'assistant' : null;
    if (!role) continue;
    const text = (b.text || '').trim();
    if (!text) continue;
    messages.push({ role, text, ts: Number(header.lastUpdatedAt) || Date.now() });
  }

  return {
    source: 'cursor',
    sessionId: composerId,
    cwd: null,
    threadName: header.name || null,
    createdAt: Number(header.createdAt) || Date.now(),
    updatedAt: Number(header.lastUpdatedAt) || Date.now(),
    messages,
    isMirror: false,
    sourcePath: `cursor:${composerId}`,
  };
}
