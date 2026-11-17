import fs from 'node:fs';
import { PATHS, isIgnoredCwd, resolveT3Db, resolveUserPath } from '../config.js';
import { info } from '../log.js';
import { loadState, saveState, getMirror, setMirror, fingerprintMessages } from '../state.js';
import { listClaudeSessions, readClaudeSession } from '../sources/claude.js';
import { listCodexSessions, readCodexSession } from '../sources/codex.js';
import { listCursorComposers, readCursorComposer } from '../sources/cursor.js';
import { listT3Threads, readT3Thread } from '../sources/t3.js';
import { writeClaudeMirror } from '../sinks/claude.js';
import { writeCodexMirror } from '../sinks/codex.js';
import { writeT3Mirror } from '../sinks/t3.js';

// One-shot sync. Doesn't require the daemon. Useful for testing or running on demand.
// `--all` ignores the epoch and tries every session newer than --since (default: 24h).
export async function sync({
  all = false,
  sinceHours = 24,
  limit = 20,
  dryRun = false,
  only = null,
  t3Workspace = null,
  cursorWorkspaces = [],
  cursorWorkspacePrefixes = [],
} = {}) {
  fs.mkdirSync(PATHS.combobulateDir, { recursive: true });
  fs.mkdirSync(PATHS.combobulateSynced, { recursive: true });

  const cutoff = all ? 0 : Date.now() - sinceHours * 3600 * 1000;
  const state = loadState();
  const sinks = new Set(only?.length ? only : ['claude', 'codex', 't3']);
  const t3Db = resolveT3Db();
  const outputWorkspace = resolveUserPath(t3Workspace) || resolveUserPath(process.env.COMBOBULATOR_T3_WORKSPACE);
  const cursorFiltered = cursorWorkspaces.length > 0 || cursorWorkspacePrefixes.length > 0;

  const sessions = [];

  if (!cursorFiltered && sinks.has('claude')) for (const meta of listClaudeSessions().slice(0, limit)) {
    if (meta.mtime < cutoff) continue;
    try {
      const s = await readClaudeSession(meta.path);
      if (isIgnoredCwd(s.cwd)) continue;
      if (!s.isMirror && s.messages.length) sessions.push(s);
    } catch (e) { /* ignore */ }
  }
  if (!cursorFiltered && sinks.has('codex')) for (const meta of listCodexSessions().slice(0, limit)) {
    if (meta.mtime < cutoff) continue;
    try {
      const s = await readCodexSession(meta.path);
      if (isIgnoredCwd(s.cwd)) continue;
      if (!s.isMirror && s.messages.length) sessions.push(s);
    } catch (e) { /* ignore */ }
  }
  if (fs.existsSync(PATHS.cursorDb)) {
    try {
      const composers = await listCursorComposers({
        workspaces: cursorWorkspaces,
        prefixes: cursorWorkspacePrefixes,
        limit,
      });
      for (const c of composers) {
        if (c.updatedAt < cutoff) continue;
        const s = await readCursorComposer(c.id);
        if (isIgnoredCwd(s?.cwd)) continue;
        if (s && !s.isMirror && s.messages.length) sessions.push(s);
      }
    } catch (e) { info(`cursor scan failed: ${e.message}`); }
  }
  if (!cursorFiltered && sinks.has('t3') && t3Db) {
    try {
      const threads = await listT3Threads();
      for (const thread of threads.slice(0, limit)) {
        if (thread.updatedAt < cutoff) continue;
        const s = await readT3Thread(thread);
        if (isIgnoredCwd(s.cwd)) continue;
        if (!s.isMirror && s.messages.length) sessions.push(s);
      }
    } catch (e) { info(`t3 scan failed: ${e.message}`); }
  }

  info(`found ${sessions.length} candidate session(s) to mirror`);

  for (const s of sessions) {
    const key = `${s.source}/${s.sessionId}`;
    const fp = fingerprintMessages(s.messages);
    const prev = getMirror(key);
    if (prev && prev.sourceFingerprint === fp) {
      info(`skip ${key} (no changes)`);
      continue;
    }
    info(`mirror ${key} (${s.messages.length} msgs)${s.cwd ? ` cwd=${s.cwd}` : ''}${outputWorkspace ? ` -> ${outputWorkspace}` : ''}`);
    if (dryRun) continue;
    const targets = prev?.targets || {};
    if (sinks.has('claude') && s.source !== 'claude') {
      const r = writeClaudeMirror(s, {
        existingSessionId: targets.claude?.sessionId,
        existingFilePath: targets.claude?.filePath,
      });
      targets.claude = r;
      info(`  -> claude:${r.sessionId}`);
    }
    if (sinks.has('codex') && s.source !== 'codex') {
      const r = writeCodexMirror(s, {
        existingSessionId: targets.codex?.sessionId,
        existingFilePath: targets.codex?.filePath,
      });
      targets.codex = r;
      info(`  -> codex:${r.sessionId}`);
    }
    if (sinks.has('t3') && s.source !== 't3' && t3Db) {
      const r = writeT3Mirror(s, { existingSessionId: targets.t3?.sessionId, workspace: outputWorkspace });
      targets.t3 = r;
      info(`  -> t3:${r.sessionId}`);
    }
    setMirror(key, { sourceFingerprint: fp, targets, lastSyncedAt: Date.now() });
  }
  saveState();
  info('done.');
}
