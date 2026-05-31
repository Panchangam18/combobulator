import fs from 'node:fs';
import { PATHS, POLL_INTERVAL_MS } from './config.js';
import { info, warn, error, debug } from './log.js';
import { loadState, saveState, getMirror, setMirror, fingerprintMessages } from './state.js';
import { listClaudeSessions, readClaudeSession } from './sources/claude.js';
import { listCodexSessions, readCodexSession } from './sources/codex.js';
import { listCursorComposers, readCursorComposer } from './sources/cursor.js';
import { writeClaudeMirror } from './sinks/claude.js';
import { writeCodexMirror } from './sinks/codex.js';

// Mirror a single normalized session to every other tool. Skip self and skip mirrors.
async function mirrorSession(session) {
  if (session.isMirror) return;
  if (!session.messages.length) return;

  const sourceKey = `${session.source}/${session.sessionId}`;
  const fp = fingerprintMessages(session.messages);
  const prev = getMirror(sourceKey);
  if (prev && prev.sourceFingerprint === fp) return; // nothing new

  const targets = prev?.targets || {};

  if (session.source !== 'claude') {
    try {
      const result = writeClaudeMirror(session, {
        existingSessionId: targets.claude?.sessionId,
        existingFilePath: targets.claude?.filePath,
      });
      targets.claude = result;
      info(`mirrored ${sourceKey} -> claude:${result.sessionId}`);
    } catch (e) {
      error(`claude mirror failed for ${sourceKey}: ${e.message}`);
    }
  }

  if (session.source !== 'codex') {
    try {
      const result = writeCodexMirror(session, {
        existingSessionId: targets.codex?.sessionId,
        existingFilePath: targets.codex?.filePath,
      });
      targets.codex = result;
      info(`mirrored ${sourceKey} -> codex:${result.sessionId}`);
    } catch (e) {
      error(`codex mirror failed for ${sourceKey}: ${e.message}`);
    }
  }

  setMirror(sourceKey, { sourceFingerprint: fp, targets, lastSyncedAt: Date.now() });
}

async function scanClaude(state) {
  const sessions = listClaudeSessions();
  for (const meta of sessions) {
    if (meta.mtime < state.epoch) continue; // pre-existing
    try {
      const session = await readClaudeSession(meta.path);
      await mirrorSession(session);
    } catch (e) {
      debug(`skip claude ${meta.path}: ${e.message}`);
    }
  }
}

async function scanCodex(state) {
  const sessions = listCodexSessions();
  for (const meta of sessions) {
    if (meta.mtime < state.epoch) continue;
    try {
      const session = await readCodexSession(meta.path);
      await mirrorSession(session);
    } catch (e) {
      debug(`skip codex ${meta.path}: ${e.message}`);
    }
  }
}

async function scanCursor(state) {
  if (!fs.existsSync(PATHS.cursorDb)) return;
  let composers;
  try {
    composers = await listCursorComposers();
  } catch (e) {
    debug(`cursor list failed: ${e.message}`);
    return;
  }
  for (const c of composers) {
    if (c.updatedAt < state.epoch) continue;
    try {
      const session = await readCursorComposer(c.id);
      if (session) await mirrorSession(session);
    } catch (e) {
      debug(`skip cursor ${c.id}: ${e.message}`);
    }
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const state = loadState();
    await scanClaude(state);
    await scanCodex(state);
    await scanCursor(state);
    saveState();
  } catch (e) {
    error(`tick failed: ${e.message}`);
  } finally {
    running = false;
  }
}

export async function runDaemon() {
  fs.mkdirSync(PATHS.combobulateDir, { recursive: true });
  fs.mkdirSync(PATHS.combobulateSynced, { recursive: true });
  fs.writeFileSync(PATHS.combobulatePid, String(process.pid));

  process.on('SIGTERM', () => { info('SIGTERM, exiting'); process.exit(0); });
  process.on('SIGINT', () => { info('SIGINT, exiting'); process.exit(0); });

  info(`daemon started pid=${process.pid} interval=${POLL_INTERVAL_MS}ms`);
  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
