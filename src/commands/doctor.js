import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { PATHS, HOME, LAUNCHD_LABEL } from '../config.js';
import { loadState } from '../state.js';

// Diagnose the combobulate setup end-to-end. Walks every moving piece and
// prints OK / WARN / FAIL for each, plus a one-line "what to do" hint.
//
// Designed to be the first thing you run when "sync isn't working." Detects:
//   - daemon not running
//   - watched paths missing
//   - epoch in the future (clock skew or fresh install)
//   - state file inconsistency
//   - broken mirror rows in Codex
//   - the daemon log mentioning recent errors
export async function doctor() {
  const checks = [];
  let ok = 0, warn = 0, fail = 0;

  const add = (status, label, detail = '') => {
    checks.push({ status, label, detail });
    if (status === 'OK') ok++;
    else if (status === 'WARN') warn++;
    else fail++;
  };

  // 1. launchd agent
  if (fs.existsSync(PATHS.launchdPlist)) {
    let listed = '';
    try { listed = execFileSync('launchctl', ['list'], { encoding: 'utf8' }); } catch {}
    const row = listed.split('\n').find((l) => l.endsWith(LAUNCHD_LABEL));
    if (row) {
      const [pid] = row.trim().split(/\s+/);
      if (pid !== '-' && Number.isFinite(Number(pid))) {
        add('OK', 'daemon', `running, pid=${pid}`);
      } else {
        add('WARN', 'daemon', `loaded but not running — try: launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`);
      }
    } else {
      add('FAIL', 'daemon', 'plist present but not loaded — try: combobulator install');
    }
  } else {
    add('FAIL', 'daemon', 'not installed — run: combobulator install');
  }

  // 2. watched source paths
  add(fs.existsSync(PATHS.claudeProjects) ? 'OK' : 'WARN', 'claude path', PATHS.claudeProjects);
  add(fs.existsSync(PATHS.codexSessions)  ? 'OK' : 'WARN', 'codex path',  PATHS.codexSessions);
  add(fs.existsSync(PATHS.cursorDb)       ? 'OK' : 'WARN', 'cursor path', PATHS.cursorDb);

  // 3. state file
  let state;
  try {
    state = loadState();
    const mirrorCount = Object.keys(state.mirrors || {}).length;
    const epoch = new Date(state.epoch);
    const now = Date.now();
    if (epoch.getTime() > now + 60000) {
      add('WARN', 'epoch', `${epoch.toISOString()} is in the future — clock skew?`);
    } else {
      add('OK', 'epoch', `${epoch.toISOString()} (${mirrorCount} mirrors tracked)`);
    }
    const sources = {};
    for (const k of Object.keys(state.mirrors || {})) {
      const s = k.split('/')[0];
      sources[s] = (sources[s] || 0) + 1;
    }
    add('OK', 'sources', Object.entries(sources).map(([k, v]) => `${k}:${v}`).join(', ') || '(none yet)');
  } catch (e) {
    add('FAIL', 'state file', `${PATHS.combobulateState}: ${e.message}`);
  }

  // 4. Codex thread-row health
  const codexDb = path.join(HOME, '.codex', 'state_5.sqlite');
  if (fs.existsSync(codexDb)) {
    try {
      const db = new DatabaseSync(codexDb);
      const unknown = db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE source='unknown' AND archived=0`).get();
      if (unknown.n > 0) {
        add('WARN', 'codex threads', `${unknown.n} row(s) flagged 'unknown' — run: combobulator discombobulate`);
      } else {
        add('OK', 'codex threads', 'all rows look healthy');
      }
      db.close();
    } catch (e) {
      add('WARN', 'codex threads', `couldn't read state_5.sqlite: ${e.message}`);
    }
  } else {
    add('OK', 'codex threads', '(Codex not installed)');
  }

  // 5. recent log errors
  if (fs.existsSync(PATHS.combobulateLog)) {
    try {
      const tail = fs.readFileSync(PATHS.combobulateLog, 'utf8').split('\n').slice(-100);
      const errors = tail.filter((l) => l.includes(' ERROR ')).slice(-3);
      if (errors.length) {
        add('WARN', 'recent log', `${errors.length} error(s) in last 100 lines — see ${PATHS.combobulateLog}`);
      } else {
        add('OK', 'recent log', 'no errors in last 100 lines');
      }
    } catch (e) {
      add('WARN', 'recent log', e.message);
    }
  }

  // print results
  console.log('\ncombobulator doctor');
  console.log('==================');
  for (const c of checks) {
    const tag = c.status === 'OK' ? '\x1b[32mOK  \x1b[0m' : c.status === 'WARN' ? '\x1b[33mWARN\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    const pad = c.label.padEnd(16);
    console.log(`  ${tag}  ${pad} ${c.detail}`);
  }
  console.log(`\n${ok} ok, ${warn} warn, ${fail} fail.`);
  if (fail > 0) process.exitCode = 1;
}
