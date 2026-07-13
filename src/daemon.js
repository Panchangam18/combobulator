import fs from 'node:fs';
import { PATHS, POLL_INTERVAL_MS } from './config.js';
import { info, warn, error, debug } from './log.js';
import { loadState, saveState, getMirror, setMirror, fingerprintMessages } from './state.js';
import { listClaudeSessions, readClaudeSession } from './sources/claude.js';
import { listCodexSessions, readCodexSession } from './sources/codex.js';
import { listCursorComposers, readCursorComposer } from './sources/cursor.js';
import { writeClaudeMirror } from './sinks/claude.js';
import { writeCodexMirror } from './sinks/codex.js';

function fileAlreadyScanned(state, meta) {
  const prev = state.scannedFiles?.[meta.path];
  return prev && prev.mtime === meta.mtime && prev.size === meta.size;
}

function markFileScanned(state, meta, session) {
  state.scannedFiles ||= {};
  state.scannedFiles[meta.path] = {
    mtime: meta.mtime,
    size: meta.size,
    source: session.source,
    sessionId: session.sessionId,
    isMirror: !!session.isMirror,
    scannedAt: Date.now(),
  };
  return true;
}

function cursorAlreadyScanned(state, composer) {
  const prev = state.scannedCursorComposers?.[composer.id];
  return prev && prev.updatedAt === composer.updatedAt;
}

function markCursorScanned(state, composer, session) {
  state.scannedCursorComposers ||= {};
  state.scannedCursorComposers[composer.id] = {
    updatedAt: composer.updatedAt,
    source: 'cursor',
    sessionId: session?.sessionId || composer.id,
    scannedAt: Date.now(),
  };
  return true;
}

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
  let changed = false;
  const sessions = listClaudeSessions();
  for (const meta of sessions) {
    if (meta.mtime < state.epoch) continue; // pre-existing
    if (fileAlreadyScanned(state, meta)) continue;
    try {
      const session = await readClaudeSession(meta.path);
      changed = markFileScanned(state, meta, session) || changed;
      await mirrorSession(session);
    } catch (e) {
      debug(`skip claude ${meta.path}: ${e.message}`);
    }
  }
  return changed;
}

async function scanCodex(state) {
  let changed = false;
  const sessions = listCodexSessions();
  for (const meta of sessions) {
    if (meta.mtime < state.epoch) continue;
    if (fileAlreadyScanned(state, meta)) continue;
    try {
      const session = await readCodexSession(meta.path);
      changed = markFileScanned(state, meta, session) || changed;
      await mirrorSession(session);
    } catch (e) {
      debug(`skip codex ${meta.path}: ${e.message}`);
    }
  }
  return changed;
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
  let changed = false;
  for (const c of composers) {
    if (c.updatedAt < state.epoch) continue;
    if (cursorAlreadyScanned(state, c)) continue;
    try {
      const session = await readCursorComposer(c.id);
      changed = markCursorScanned(state, c, session) || changed;
      if (session) await mirrorSession(session);
    } catch (e) {
      debug(`skip cursor ${c.id}: ${e.message}`);
    }
  }
  return changed;
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const state = loadState();
    const claudeChanged = await scanClaude(state);
    const codexChanged = await scanCodex(state);
    const cursorChanged = await scanCursor(state);
    const changed = claudeChanged || codexChanged || cursorChanged;
    if (changed) saveState();
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
