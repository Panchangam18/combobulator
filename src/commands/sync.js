import fs from 'node:fs';
import { PATHS } from '../config.js';
import { info } from '../log.js';
import { loadState, saveState, getMirror, setMirror, fingerprintMessages } from '../state.js';
import { listClaudeSessions, readClaudeSession } from '../sources/claude.js';
import { listCodexSessions, readCodexSession } from '../sources/codex.js';
import { listCursorComposers, readCursorComposer } from '../sources/cursor.js';
import { writeClaudeMirror } from '../sinks/claude.js';
import { writeCodexMirror } from '../sinks/codex.js';

// One-shot sync. Doesn't require the daemon. Useful for testing or running on demand.
// `--all` ignores the epoch and tries every session newer than --since (default: 24h).
export async function sync({ all = false, sinceHours = 24, limit = 20, dryRun = false } = {}) {
  fs.mkdirSync(PATHS.combobulateDir, { recursive: true });
  fs.mkdirSync(PATHS.combobulateSynced, { recursive: true });

  const cutoff = all ? 0 : Date.now() - sinceHours * 3600 * 1000;
  const state = loadState();

  const sessions = [];

  for (const meta of listClaudeSessions().slice(0, limit)) {
    if (meta.mtime < cutoff) continue;
    try {
      const s = await readClaudeSession(meta.path);
      if (!s.isMirror && s.messages.length) sessions.push(s);
    } catch (e) { /* ignore */ }
  }
  for (const meta of listCodexSessions().slice(0, limit)) {
    if (meta.mtime < cutoff) continue;
    try {
      const s = await readCodexSession(meta.path);
      if (!s.isMirror && s.messages.length) sessions.push(s);
    } catch (e) { /* ignore */ }
  }
  if (fs.existsSync(PATHS.cursorDb)) {
    try {
      const composers = await listCursorComposers();
      for (const c of composers.slice(0, limit)) {
        if (c.updatedAt < cutoff) continue;
        const s = await readCursorComposer(c.id);
        if (s && !s.isMirror && s.messages.length) sessions.push(s);
      }
    } catch (e) { info(`cursor scan failed: ${e.message}`); }
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
    info(`mirror ${key} (${s.messages.length} msgs)`);
    if (dryRun) continue;
    const targets = prev?.targets || {};
    if (s.source !== 'claude') {
      const r = writeClaudeMirror(s, {
        existingSessionId: targets.claude?.sessionId,
        existingFilePath: targets.claude?.filePath,
      });
      targets.claude = r;
      info(`  -> claude:${r.sessionId}`);
    }
    if (s.source !== 'codex') {
      const r = writeCodexMirror(s, {
        existingSessionId: targets.codex?.sessionId,
        existingFilePath: targets.codex?.filePath,
      });
      targets.codex = r;
      info(`  -> codex:${r.sessionId}`);
    }
    setMirror(key, { sourceFingerprint: fp, targets, lastSyncedAt: Date.now() });
  }
  saveState();
  info('done.');
}
