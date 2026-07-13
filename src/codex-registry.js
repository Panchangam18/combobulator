import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, isIgnoredCwd } from './config.js';
import { info, warn } from './log.js';

const execFileP = promisify(execFile);

const STATE_FILE = path.join(HOME, '.codex', '.codex-global-state.json');

// Tell Codex Desktop to treat `cwd` as one of its workspace roots so the mirrored
// chats become visible in the per-cwd sidebar.
//
// We discovered the hard way that editing `.codex-global-state.json` directly is
// unreliable: Codex Desktop caches the file in memory and writes it back on
// shutdown, clobbering our additions. The correct mechanism is `codex app <path>`
// — Codex's own CLI command that sends an IPC to the running app to register the
// workspace (or launch + register if it isn't running). This persists.
//
// Side effect: `codex app` focuses Codex Desktop on the registered workspace.
// We accept that for one-time registration but skip the call entirely if the
// cwd is already in workspace-roots — so daemon-driven mirroring of an
// already-tracked cwd doesn't cause focus theft.
export async function registerCodexWorkspaceRoot(cwd) {
  if (!cwd || !cwd.startsWith('/')) return false;
  if (isIgnoredCwd(cwd)) return false;
  if (!fs.existsSync(cwd)) return false;
  if (isAlreadyRegistered(cwd)) return false;

  try {
    await execFileP('codex', ['app', cwd], { timeout: 8000 });
    info(`registered Codex workspace root via codex app: ${cwd}`);
    return true;
  } catch (e) {
    warn(`codex app failed for ${cwd}: ${e.message}`);
    // Fallback: try the direct JSON write. May get overwritten on Codex shutdown,
    // but better than nothing for fresh installs where Codex isn't running yet.
    return jsonFallback(cwd);
  }
}

function isAlreadyRegistered(cwd) {
  if (!fs.existsSync(STATE_FILE)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Array.isArray(state['electron-saved-workspace-roots']) &&
      state['electron-saved-workspace-roots'].includes(cwd);
  } catch {
    return false;
  }
}

function jsonFallback(cwd) {
  if (!fs.existsSync(STATE_FILE)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const roots = state['electron-saved-workspace-roots'];
    const order = state['project-order'];
    if (!Array.isArray(roots) || !Array.isArray(order)) return false;
    let changed = false;
    if (!roots.includes(cwd)) { roots.push(cwd); changed = true; }
    if (!order.includes(cwd)) { order.unshift(cwd); changed = true; }
    if (!changed) return false;
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
    info(`registered Codex workspace root via JSON fallback: ${cwd} (may be overwritten by Codex on shutdown)`);
    return true;
  } catch (e) {
    warn(`JSON fallback failed for ${cwd}: ${e.message}`);
    return false;
  }
}
