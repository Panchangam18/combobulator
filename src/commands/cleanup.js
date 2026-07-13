import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PATHS, HOME, isMirrorMarker } from '../config.js';
import { info, warn } from '../log.js';
import { loadState, saveState } from '../state.js';

const CODEX_DB = path.join(HOME, '.codex', 'state_5.sqlite');

// Sweep any Combobulator-authored rows that Codex's app-server has flipped to
// source='unknown' (typically rollouts written before the format was
// production-correct), plus orphaned thread rows whose rollout_path no longer
// exists on disk. Safe to run anytime — only touches Combobulator-authored rows.
//
// Plain cleanup never touches rollout/session files. With --all, only files
// carrying our mirror marker are removed; original chats are always preserved.
export async function cleanup({ dryRun = false, all = false } = {}) {
  const state = loadState();
  const mirrorFiles = all ? findAllMirrorFiles() : [];
  const mirrorPaths = new Set(mirrorFiles.map((entry) => entry.filePath));
  const mirrorIds = new Set(mirrorFiles.map((entry) => entry.sessionId).filter(Boolean));
  for (const record of Object.values(state.mirrors || {})) {
    for (const target of Object.values(record.targets || {})) {
      if (target?.filePath) mirrorPaths.add(target.filePath);
      if (target?.sessionId) mirrorIds.add(target.sessionId);
    }
  }
  const toDelete = [];

  let db = null;
  if (fs.existsSync(CODEX_DB)) {
    db = new DatabaseSync(CODEX_DB);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

  // Pull every row that LOOKS like one of ours (we'll confirm by peeking the
  // rollout file). We can't rely on `source` alone because Codex rewrites it.
    const where = all ? '' : ' WHERE archived = 0';
    const rows = db.prepare(`SELECT id, source, rollout_path FROM threads${where}`).all();
    let combobulateConfirmed = 0;
    let orphaned = 0;
    let unknownSource = 0;

    for (const r of rows) {
      const isOurs = mirrorPaths.has(r.rollout_path) || looksLikeCombobulateRollout(r.rollout_path);
      const exists = r.rollout_path && fs.existsSync(r.rollout_path);

      if (isOurs) combobulateConfirmed++;

    // Three deletion criteria:
    //  (a) Our mirror file is gone — orphaned row
    //  (b) Marked unknown source AND the rollout file is missing too
    //  (c) Marked unknown source AND the file IS ours (we have a fresh rewrite
    //      pending and want Codex to re-import from scratch)
      if (all && isOurs) toDelete.push(r);
      else if (isOurs && !exists) { toDelete.push(r); orphaned++; }
      else if (r.source === 'unknown' && !exists) { toDelete.push(r); orphaned++; }
      else if (r.source === 'unknown' && isOurs) { toDelete.push(r); unknownSource++; }
    }

    info(`scanned ${rows.length} threads.`);
    info(`  combobulator-authored: ${combobulateConfirmed}`);
    info(all
      ? `  mirror rows to delete: ${toDelete.length}`
      : `  to delete: ${toDelete.length} (${orphaned} orphaned, ${unknownSource} unknown-source)`);
  } else {
    info('Codex state_5.sqlite not present.');
  }

  if (!all && !toDelete.length) {
    db?.close();
    return;
  }

  if (dryRun) {
    info('(dry-run) would delete:');
    for (const r of toDelete.slice(0, 20)) info(`  ${r.id}  source=${r.source}  path=${r.rollout_path}`);
    if (toDelete.length > 20) info(`  ... and ${toDelete.length - 20} more`);
    if (all) info(`(dry-run) would delete ${mirrorFiles.length} mirror file(s) and clear mirror tracking.`);
    db?.close();
    return;
  }

  if (db) {
    const stmt = db.prepare('DELETE FROM threads WHERE id = ?');
    for (const r of toDelete) {
      try { stmt.run(r.id); } catch (e) { warn(`failed to delete ${r.id}: ${e.message}`); }
    }
    db.close();
  }
  info(`deleted ${toDelete.length} row(s).`);

  if (all) {
    for (const entry of mirrorFiles) {
      try { fs.unlinkSync(entry.filePath); } catch (e) { warn(`failed to delete ${entry.filePath}: ${e.message}`); }
    }
    rewriteJsonl(PATHS.codexSessionIndex, (record) => !mirrorIds.has(record.id));
    rewriteJsonl(PATHS.codexHistory, (record) => !mirrorIds.has(record.session_id));
    rewriteJsonl(PATHS.claudeHistory, (record) => record.combobulator !== true);
    state.mirrors = {};
    for (const entry of mirrorFiles) delete state.scannedFiles?.[entry.filePath];
    saveState();
    info(`deleted ${mirrorFiles.length} mirror file(s) and cleared mirror tracking.`);
  }
  info('Restart Codex Desktop to refresh its in-memory chat list.');
}

function findAllMirrorFiles() {
  const out = [];
  walkJsonl(PATHS.claudeProjects, (filePath) => {
    if (readMirrorMarker(filePath)) out.push({ filePath, sessionId: path.basename(filePath, '.jsonl') });
  });
  walkJsonl(PATHS.codexSessions, (filePath) => {
    const marker = readMirrorMarker(filePath);
    if (marker) out.push({ filePath, sessionId: marker.sessionId });
  });
  return out;
}

function walkJsonl(root, visit) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(full, visit);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) visit(full);
  }
}

function readMirrorMarker(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n').slice(0, 3)) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (isMirrorMarker(record)) return { sessionId: record.sessionId || path.basename(filePath, '.jsonl') };
      const marker = record.type === 'session_meta' && (record.payload?.combobulator || record.payload?.combobulate);
      if (isMirrorMarker(marker)) return { sessionId: record.payload?.id };
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
  return null;
}

function rewriteJsonl(filePath, keep) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const kept = lines.filter((line) => {
    try { return keep(JSON.parse(line)); } catch { return true; }
  });
  const tmp = `${filePath}.combobulator-tmp`;
  fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
  fs.renameSync(tmp, filePath);
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
