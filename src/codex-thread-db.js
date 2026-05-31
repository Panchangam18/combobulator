import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';
import { warn } from './log.js';

const DB = path.join(HOME, '.codex', 'state_5.sqlite');

// Insert or replace a row in Codex Desktop's threads table so the mirrored
// chat is visible in the per-cwd sidebar. The schema is in state_5.sqlite —
// idx_threads_archived_cwd_updated_at_ms is the index the sidebar queries.
// The DB is WAL'd, so concurrent writes alongside a running Codex Desktop are
// safe (SQLite serializes them at the page level).
export function upsertCodexThread({
  sessionId,
  rolloutPath,
  cwd,
  title,
  firstUserMessage,
  createdAtMs,
  updatedAtMs,
  approxTokens,
}) {
  if (!fs.existsSync(DB)) return false;

  let db;
  try {
    db = new DatabaseSync(DB);
    // Match Codex's pragmas — WAL with NORMAL synchronous so we don't fsync
    // every transaction and slow Codex down.
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

    // IMPORTANT: Codex Desktop's chat sidebar filters out threads with
    //   source='cli' AND tokens_used=0 AND preview=''
    // (treating them as empty drafts and hiding them). To make mirrored chats
    // actually show up, we set preview to a snippet of the first user message
    // and tokens_used to a positive estimate. This matches what Codex itself
    // writes for "real" threads.
    const fum = (firstUserMessage || '').slice(0, 2000);
    const preview = fum ? fum.slice(0, 200) : 'Synced from combobulate';
    const tokens = Math.max(1, approxTokens || Math.ceil(fum.length / 4));

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO threads
        (id, rollout_path, created_at, updated_at, source, model_provider, cwd,
         title, sandbox_policy, approval_mode, has_user_event, archived,
         cli_version, first_user_message, memory_mode, preview, tokens_used)
      VALUES
        (?, ?, ?, ?, 'cli', 'openai', ?,
         ?, '{"type":"danger-full-access"}', 'never', 1, 0,
         '0.1.0', ?, 'enabled', ?, ?)
    `);

    stmt.run(
      sessionId,
      rolloutPath,
      Math.floor(createdAtMs / 1000),
      Math.floor(updatedAtMs / 1000),
      cwd,
      (title || 'Synced from combobulate').slice(0, 200),
      fum,
      preview,
      tokens,
    );
    return true;
  } catch (e) {
    warn(`codex threads upsert failed: ${e.message}`);
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}
