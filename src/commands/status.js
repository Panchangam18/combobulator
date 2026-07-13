import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PATHS, LAUNCHD_LABEL } from '../config.js';
import { loadState } from '../state.js';

export async function status() {
  console.log('combobulator status');
  console.log('==================');
  console.log(`state file:  ${PATHS.combobulateState}`);
  console.log(`log file:    ${PATHS.combobulateLog}`);
  console.log(`synced cwd:  ${PATHS.combobulateSynced}`);
  console.log(`plist:       ${PATHS.launchdPlist} ${fs.existsSync(PATHS.launchdPlist) ? '(present)' : '(missing)'}`);

  // launchctl list returns the PID if loaded
  let listed = '';
  try {
    listed = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
  } catch {}
  const row = listed.split('\n').find((l) => l.endsWith(LAUNCHD_LABEL));
  if (row) {
    const [pid, _exit, label] = row.trim().split(/\s+/);
    console.log(`launchd:     loaded as ${label}, pid=${pid === '-' ? 'not running' : pid}`);
  } else {
    console.log('launchd:     not loaded');
  }

  let state;
  try { state = loadState(); } catch { state = null; }
  if (state) {
    const mirrors = Object.entries(state.mirrors || {});
    console.log(`epoch:       ${new Date(state.epoch).toISOString()}`);
    console.log(`mirrors:     ${mirrors.length} session(s) tracked`);
    if (mirrors.length) {
      const recent = mirrors
        .map(([k, v]) => ({ k, ...v }))
        .sort((a, b) => (b.lastSyncedAt || 0) - (a.lastSyncedAt || 0))
        .slice(0, 5);
      console.log('recent syncs:');
      for (const r of recent) {
        const targets = Object.keys(r.targets || {}).join('+');
        console.log(`  ${new Date(r.lastSyncedAt || 0).toISOString()}  ${r.k}  -> ${targets}`);
      }
    }
  }

  console.log('\nWatched paths:');
  console.log(`  claude:  ${PATHS.claudeProjects} ${fs.existsSync(PATHS.claudeProjects) ? '✓' : '✗'}`);
  console.log(`  codex:   ${PATHS.codexSessions}  ${fs.existsSync(PATHS.codexSessions) ? '✓' : '✗'}`);
  console.log(`  cursor:  ${PATHS.cursorDb}  ${fs.existsSync(PATHS.cursorDb) ? '✓' : '✗ (cursor not installed)'}`);
}
