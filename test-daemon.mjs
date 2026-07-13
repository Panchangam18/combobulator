// Runs the orchestrator loop once over a synthetic environment and asserts the
// mirror was actually produced. This is the "daemon's eyes" view, smaller than e2e.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'combobulator-daemon-'));
process.env.HOME = ROOT;

const { PATHS } = await import('./src/config.js');
const { resetEpoch } = await import('./src/state.js');

// Create one synthetic Codex session newer than the epoch.
resetEpoch();
await new Promise((r) => setTimeout(r, 10));

fs.mkdirSync(path.join(PATHS.codexSessions, '2026', '05', '16'), { recursive: true });
const codexFile = path.join(PATHS.codexSessions, '2026', '05', '16', 'rollout-2026-05-16T20-00-00-019e3000-0000-7000-8000-000000000099.jsonl');
const lines = [
  { timestamp: '2026-05-16T20:00:00Z', type: 'session_meta', payload: { id: '019e3000-0000-7000-8000-000000000099', cwd: '/Users/madhavan/proj', originator: 'Codex Desktop' } },
  { timestamp: '2026-05-16T20:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello world', images: [] } },
  { timestamp: '2026-05-16T20:00:03Z', type: 'event_msg', payload: { type: 'agent_message', message: 'hi!' } },
];
fs.writeFileSync(codexFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.utimesSync(codexFile, new Date(), new Date()); // ensure mtime > epoch

// Import daemon's helpers and run one tick manually (without the setInterval loop).
const daemonMod = await import('./src/daemon.js');
let watchEvent;
const eventSeen = new Promise((resolve) => { watchEvent = resolve; });
const watcher = daemonMod.watchSessionStorage(watchEvent);
fs.appendFileSync(codexFile, '\n');
await Promise.race([
  eventSeen,
  new Promise((_, reject) => setTimeout(() => reject(new Error('filesystem watcher did not fire')), 2000)),
]);
watcher.close();
console.log('✓ filesystem event triggers a debounced sync notification');
// runDaemon spawns an infinite interval — we don't want that here. Instead we
// import the internal scanClaude/scanCodex via a direct sync invocation.
const syncMod = await import('./src/commands/sync.js');
await syncMod.sync({ all: true, sinceHours: 24 * 30, limit: 20 });

// Verify a Claude mirror was created under the source cwd's encoded project dir.
const projDir = path.join(PATHS.claudeProjects, '-Users-madhavan-proj');
assert.ok(fs.existsSync(projDir), `expected mirror project dir at ${projDir}`);
const mirrors = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
assert.equal(mirrors.length, 1, `expected 1 mirror file, got ${mirrors.length}`);
console.log('✓ daemon-style sync produced exactly one Claude mirror');

// Run a SECOND tick — should be a no-op since the source fingerprint hasn't changed.
const histBefore = fs.readFileSync(PATHS.claudeHistory, 'utf8');
await syncMod.sync({ all: true, sinceHours: 24 * 30, limit: 20 });
const histAfter = fs.readFileSync(PATHS.claudeHistory, 'utf8');
assert.equal(histAfter, histBefore, 'second tick should not change history');
const mirrors2 = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
assert.equal(mirrors2.length, 1, 'second tick should not create a second mirror');
console.log('✓ second tick is a no-op (fingerprint unchanged)');

// Append a new user message to the source and re-tick — should rewrite, not duplicate.
const newLines = lines.concat([
  { timestamp: '2026-05-16T20:00:10Z', type: 'event_msg', payload: { type: 'user_message', message: 'follow-up', images: [] } },
]);
fs.writeFileSync(codexFile, newLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
await syncMod.sync({ all: true, sinceHours: 24 * 30, limit: 20 });
const mirrors3 = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
assert.equal(mirrors3.length, 1, 'follow-up tick should rewrite same file, not create new');
const rewritten = fs.readFileSync(path.join(projDir, mirrors3[0]), 'utf8');
assert.ok(rewritten.includes('follow-up'), 'rewritten mirror should include the new message');
console.log('✓ follow-up tick rewrites same mirror file with new content');

console.log('\nDaemon orchestration verified.');
console.log(`Artifacts: ${ROOT}`);
