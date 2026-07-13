import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PATHS, HOME, isMirrorMarker } from '../config.js';
import { info, warn } from '../log.js';

const CODEX_DB = path.join(HOME, '.codex', 'state_5.sqlite');

// Sweep any Combobulator-authored rows that Codex's app-server has flipped to
// source='unknown' (typically rollouts written before the format was
// production-correct), plus orphaned thread rows whose rollout_path no longer
// exists on disk. Safe to run anytime — only touches Combobulator-authored rows.
//
// What we DON'T touch: rollout files themselves, claude session files, your
// own non-mirror Codex threads. If you need a truly clean slate use
// `combobulator uninstall && rm -rf ~/.combobulator`.
export async function cleanup({ dryRun = false } = {}) {
  if (!fs.existsSync(CODEX_DB)) {
    info('Codex state_5.sqlite not present — nothing to clean up.');
    return;
  }

  const db = new DatabaseSync(CODEX_DB);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

  // Pull every row that LOOKS like one of ours (we'll confirm by peeking the
  // rollout file). We can't rely on `source` alone because Codex rewrites it.
  const rows = db.prepare(`SELECT id, source, rollout_path FROM threads WHERE archived = 0`).all();

  const toDelete = [];
  let combobulateConfirmed = 0;
  let orphaned = 0;
  let unknownSource = 0;

  for (const r of rows) {
    const isOurs = looksLikeCombobulateRollout(r.rollout_path);
    const exists = r.rollout_path && fs.existsSync(r.rollout_path);

    if (isOurs) combobulateConfirmed++;

    // Three deletion criteria:
    //  (a) Our mirror file is gone — orphaned row
    //  (b) Marked unknown source AND the rollout file is missing too
    //  (c) Marked unknown source AND the file IS ours (we have a fresh rewrite
    //      pending and want Codex to re-import from scratch)
    if (isOurs && !exists) { toDelete.push(r); orphaned++; }
    else if (r.source === 'unknown' && !exists) { toDelete.push(r); orphaned++; }
    else if (r.source === 'unknown' && isOurs) { toDelete.push(r); unknownSource++; }
  }

  info(`scanned ${rows.length} threads.`);
  info(`  combobulator-authored: ${combobulateConfirmed}`);
  info(`  to delete: ${toDelete.length} (${orphaned} orphaned, ${unknownSource} unknown-source)`);

  if (!toDelete.length) {
    db.close();
    return;
  }

  if (dryRun) {
    info('(dry-run) would delete:');
    for (const r of toDelete.slice(0, 20)) info(`  ${r.id}  source=${r.source}  path=${r.rollout_path}`);
    if (toDelete.length > 20) info(`  ... and ${toDelete.length - 20} more`);
    db.close();
    return;
  }

  const stmt = db.prepare('DELETE FROM threads WHERE id = ?');
  for (const r of toDelete) {
    try { stmt.run(r.id); } catch (e) { warn(`failed to delete ${r.id}: ${e.message}`); }
  }
  db.close();
  info(`deleted ${toDelete.length} row(s).`);
  info('Restart Codex Desktop to refresh its in-memory chat list.');
}

// Cheap check: peek the first ~16KB of a rollout file and look for our marker
// (either the legacy top-level field or the new nested location). Returns
// false for any file we didn't author.
function looksLikeCombobulateRollout(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.subarray(0, n).toString('utf8').split('\n').slice(0, 3);
    for (const line of lines) {
      if (!line) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (isMirrorMarker(d)) return true;
      if (d.type === 'session_meta') {
        if (d.payload?.originator === 'combobulate') return true;
        if (isMirrorMarker(d.payload?.combobulate) || isMirrorMarker(d.payload?.combobulator)) return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}
