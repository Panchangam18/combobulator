import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { PATHS, SQLITE_BIN } from '../config.js';

const execFileP = promisify(execFile);

// Query Cursor's sqlite db read-only. We use the system `sqlite3` CLI with `mode=ro`
// so we never hold a write lock against Cursor's running process.
async function sqlite(query) {
  if (!fs.existsSync(PATHS.cursorDb)) return [];
  // Use file: URI with mode=ro for read-only opening; immutable=1 avoids touching the journal.
  const uri = `file:${PATHS.cursorDb}?mode=ro&immutable=1`;
  const { stdout } = await execFileP(SQLITE_BIN, ['-json', uri, query], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!stdout.trim()) return [];
  try { return JSON.parse(stdout); } catch { return []; }
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function likeLiteral(value) {
  const escaped = String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
    .replaceAll("'", "''");
  return `'${escaped}'`;
}

// Exact workspace paths, plus directory prefixes (the path itself and its children).
export function cursorWorkspaceClause(workspaces = [], prefixes = []) {
  const clauses = [];
  for (const workspace of workspaces) {
    clauses.push(`json_extract(value, '$.workspaceIdentifier.uri.fsPath') = ${sqlLiteral(workspace)}`);
  }
  for (const prefix of prefixes) {
    const base = prefix.replace(/\/+$/, '');
    clauses.push(`json_extract(value, '$.workspaceIdentifier.uri.fsPath') = ${sqlLiteral(base)}`);
    clauses.push(`json_extract(value, '$.workspaceIdentifier.uri.fsPath') LIKE ${likeLiteral(`${base}/`)} || '%' ESCAPE '\\'`);
  }
  return clauses.length ? `AND (${clauses.join(' OR ')})` : '';
}

async function conversationHeaderOrder(composerId) {
  const rows = await sqlite(
    `SELECT key, value FROM cursorDiskKV
      WHERE key LIKE 'composerConvHeaders:${composerId}:%'
      ORDER BY key;`
  );
  const ids = [];
  for (const row of rows) {
    try {
      const headers = JSON.parse(row.value);
      if (!Array.isArray(headers)) continue;
      for (const header of headers) if (header?.bubbleId) ids.push(header.bubbleId);
    } catch { /* a bad chunk should not drop the rest of the chat */ }
  }
  return ids;
}

export function cursorCwd(header) {
  const fsPath = header?.workspaceIdentifier?.uri?.fsPath;
  return typeof fsPath === 'string' && fsPath.startsWith('/') ? fsPath : null;
}

// List Cursor composers (chats) sorted newest-first by lastUpdatedAt.
// workspaces/prefixes restrict to those Cursor workspace roots. Without them,
// the default cap stays 200 so the daemon does not scan every historical chat.
export async function listCursorComposers({ workspaces = [], prefixes = [], limit = 200 } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? `LIMIT ${Math.floor(limit)}` : '';
  const rows = await sqlite(
    `SELECT json_extract(value, '$.composerId') as id,
            json_extract(value, '$.name') as name,
            json_extract(value, '$.lastUpdatedAt') as updatedAt,
            json_extract(value, '$.createdAt') as createdAt,
            json_extract(value, '$.workspaceIdentifier.uri.fsPath') as cwd
       FROM cursorDiskKV
      WHERE key LIKE 'composerData:%'
      ${cursorWorkspaceClause(workspaces, prefixes)}
      ORDER BY updatedAt DESC NULLS LAST
      ${cap};`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    cwd: typeof r.cwd === 'string' && r.cwd.startsWith('/') ? r.cwd : null,
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

  let bubbleOrder = (header.fullConversationHeadersOnly || []).map((h) => h.bubbleId).filter(Boolean);
  if (!bubbleOrder.length) bubbleOrder = await conversationHeaderOrder(composerId);

  // Pull all bubbles for this composer in one query.
  const bubbleRows = await sqlite(
    `SELECT substr(key, ${('bubbleId:' + composerId + ':').length + 1}) as bid,
            json_extract(value, '$.type') as bt,
            json_extract(value, '$.text') as text,
            json_extract(value, '$.createdAt') as createdAt
       FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:${composerId}:%';`
  );

  const byId = new Map();
  for (const r of bubbleRows) byId.set(r.bid, r);
  if (!bubbleOrder.length) {
    bubbleOrder = [...byId.values()]
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.bid).localeCompare(String(b.bid)))
      .map((row) => row.bid);
  }

  const messages = [];
  for (const bid of bubbleOrder) {
    const b = byId.get(bid);
    if (!b) continue;
    const role = b.bt === 1 ? 'user' : b.bt === 2 ? 'assistant' : null;
    if (!role) continue;
    const text = (b.text || '').trim();
    if (!text) continue;
    const created = Date.parse(b.createdAt);
    messages.push({ role, text, ts: Number.isFinite(created) ? created : (Number(header.lastUpdatedAt) || Date.now()) });
  }

  return {
    source: 'cursor',
    sessionId: composerId,
    cwd: cursorCwd(header),
    threadName: header.name || null,
    createdAt: Number(header.createdAt) || Date.now(),
    updatedAt: Number(header.lastUpdatedAt) || Date.now(),
    messages,
    isMirror: false,
    sourcePath: `cursor:${composerId}`,
  };
}
