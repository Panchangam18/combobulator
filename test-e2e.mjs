// Isolated end-to-end test. Builds synthetic Codex + Claude sessions under a temp
// directory, runs the source readers and sinks, and re-reads the mirrors back to
// confirm they parse, contain the right content, and would be skipped by the source
// readers as mirrors.
//
// Run with: node test-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'combobulate-e2e-'));
console.log(`test root: ${ROOT}`);

// We need to override the PATHS constants. The simplest reliable way is to set
// HOME (and the Cursor path env if we cared, but we don't here) before importing
// the modules under test.
process.env.HOME = ROOT;
process.env.COMBOBULATE_DEBUG = '1';

const { PATHS, encodeClaudeProjectDir } = await import('./src/config.js');
const { readCodexSession } = await import('./src/sources/codex.js');
const { readClaudeSession, listClaudeSessions } = await import('./src/sources/claude.js');
const { writeClaudeMirror } = await import('./src/sinks/claude.js');
const { writeCodexMirror } = await import('./src/sinks/codex.js');

// --- Build a synthetic Codex session ---
fs.mkdirSync(PATHS.codexSessions, { recursive: true });
const codexDay = path.join(PATHS.codexSessions, '2026', '05', '16');
fs.mkdirSync(codexDay, { recursive: true });
const codexId = '019e3000-0000-7000-8000-000000000001';
const codexFile = path.join(codexDay, `rollout-2026-05-16T20-00-00-${codexId}.jsonl`);
const fakeCwd = '/Users/madhavan/some-project';
const codexLines = [
  { timestamp: '2026-05-16T20:00:00Z', type: 'session_meta', payload: { id: codexId, timestamp: '2026-05-16T20:00:00Z', cwd: fakeCwd, originator: 'Codex Desktop', cli_version: '0.122.0', source: 'vscode', model_provider: 'openai' } },
  { timestamp: '2026-05-16T20:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>' }] } },
  { timestamp: '2026-05-16T20:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'build me a counter app in react', images: [] } },
  { timestamp: '2026-05-16T20:00:03Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Sure! I created Counter.tsx with useState for the count.' } },
  { timestamp: '2026-05-16T20:00:04Z', type: 'event_msg', payload: { type: 'user_message', message: 'now add a dark mode toggle', images: [] } },
  { timestamp: '2026-05-16T20:00:05Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Done — wrapped the app in a ThemeContext and added a toggle button.' } },
];
fs.writeFileSync(codexFile, codexLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// --- Read it back via source ---
const codexSession = await readCodexSession(codexFile);
assert.equal(codexSession.source, 'codex');
assert.equal(codexSession.sessionId, codexId);
assert.equal(codexSession.cwd, fakeCwd);
assert.equal(codexSession.isMirror, false);
assert.equal(codexSession.messages.length, 4, 'should drop env_context, keep 2 user + 2 assistant');
assert.equal(codexSession.messages[0].role, 'user');
assert.equal(codexSession.messages[0].text, 'build me a counter app in react');
assert.equal(codexSession.messages[3].role, 'assistant');
console.log('✓ codex source reader');

// --- Mirror to Claude ---
const claudeResult = writeClaudeMirror(codexSession);
assert.ok(fs.existsSync(claudeResult.filePath), `claude mirror file should exist at ${claudeResult.filePath}`);
const expectedProjDir = path.join(PATHS.claudeProjects, encodeClaudeProjectDir(fakeCwd));
assert.ok(claudeResult.filePath.startsWith(expectedProjDir), `mirror should be under ${expectedProjDir}, got ${claudeResult.filePath}`);
console.log(`✓ claude sink wrote mirror at ${path.relative(ROOT, claudeResult.filePath)}`);

// --- Verify the mirror parses as a Claude session and is flagged isMirror ---
const claudeReadBack = await readClaudeSession(claudeResult.filePath);
assert.equal(claudeReadBack.isMirror, true, 'mirror file should be detected as a mirror');
console.log('✓ claude reader detects mirror (loop prevented)');

// --- Verify Claude history.jsonl was appended ---
assert.ok(fs.existsSync(PATHS.claudeHistory), 'claude history should be created');
const lastHist = fs.readFileSync(PATHS.claudeHistory, 'utf8').trim().split('\n').pop();
const histEntry = JSON.parse(lastHist);
assert.ok(histEntry.display.includes('[Codex]'), `history display should mention source, got: ${histEntry.display.slice(0, 80)}`);
assert.ok(histEntry.display.includes('now add a dark mode toggle'), 'history should contain last user prompt');
console.log('✓ claude history.jsonl entry written');

// --- Mirror to Codex ---
const codexResult = writeCodexMirror(codexSession);
assert.ok(fs.existsSync(codexResult.filePath), 'codex mirror file should exist');
const codexReadBack = await readCodexSession(codexResult.filePath);
assert.equal(codexReadBack.isMirror, true, 'codex mirror should be detected (originator=combobulate OR marker)');
console.log('✓ codex sink wrote mirror + mirror detection works');

// --- Verify codex session_index entry was appended ---
assert.ok(fs.existsSync(PATHS.codexSessionIndex));
const idxLine = fs.readFileSync(PATHS.codexSessionIndex, 'utf8').trim().split('\n').pop();
const idx = JSON.parse(idxLine);
assert.equal(idx.id, codexResult.sessionId);
console.log('✓ codex session_index entry written');

// --- Verify the full flow: now mirror that same session AGAIN via fingerprint dedup logic ---
// (Importing state.js gives us the dedup primitives.)
const { fingerprintMessages, getMirror, setMirror, loadState, saveState } = await import('./src/state.js');
const fp1 = fingerprintMessages(codexSession.messages);
setMirror('codex/' + codexId, { sourceFingerprint: fp1, targets: { claude: claudeResult }, lastSyncedAt: Date.now() });
saveState();
const stored = getMirror('codex/' + codexId);
assert.equal(stored.sourceFingerprint, fp1);
console.log('✓ state persistence works');

// --- Test that adding a new message changes the fingerprint ---
const fp2 = fingerprintMessages([...codexSession.messages, { role: 'user', text: 'and ship it', ts: Date.now() }]);
assert.notEqual(fp1, fp2);
console.log('✓ fingerprint detects new messages');

// --- Now build a synthetic Claude session and verify the reverse direction ---
const claudeCwd = '/Users/madhavan/another-project';
const claudeProjDir = path.join(PATHS.claudeProjects, encodeClaudeProjectDir(claudeCwd));
fs.mkdirSync(claudeProjDir, { recursive: true });
const claudeId = crypto.randomUUID();
const claudeFile = path.join(claudeProjDir, `${claudeId}.jsonl`);
const claudeLines = [
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the failing test in src/foo.test.ts' }] }, uuid: crypto.randomUUID(), timestamp: '2026-05-16T21:00:00Z', cwd: claudeCwd, sessionId: claudeId, version: '2.1.111' },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Found the issue — the mock wasn't being reset between tests. Fixed by adding beforeEach." }] }, uuid: crypto.randomUUID(), timestamp: '2026-05-16T21:00:05Z', sessionId: claudeId },
];
fs.writeFileSync(claudeFile, claudeLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

const claudeSession = await readClaudeSession(claudeFile);
assert.equal(claudeSession.isMirror, false);
assert.equal(claudeSession.messages.length, 2);
assert.equal(claudeSession.messages[0].text, 'fix the failing test in src/foo.test.ts');
console.log('✓ claude source reader');

const codexMirrorOfClaude = writeCodexMirror(claudeSession);
assert.ok(fs.existsSync(codexMirrorOfClaude.filePath));
const reread = await readCodexSession(codexMirrorOfClaude.filePath);
assert.equal(reread.isMirror, true, 'codex mirror of claude must be flagged as mirror');
console.log('✓ end-to-end: claude → codex mirror + loop prevention');

// --- Finally: listClaudeSessions should find the mirror file (mirrors are still session files) ---
const listed = listClaudeSessions();
const found = listed.find((s) => s.path === claudeResult.filePath);
assert.ok(found, 'mirror file should appear in listing (we filter at read-time, not list-time)');
console.log('✓ listing includes mirror file; mirror filtering happens at read-time');

// --- Update-in-place: re-mirroring with existingSessionId/filePath should
//     overwrite the same file and NOT append more history.jsonl entries. ---
const histLinesBefore = fs.readFileSync(PATHS.claudeHistory, 'utf8').trim().split('\n').length;
const idxLinesBefore = fs.readFileSync(PATHS.codexSessionIndex, 'utf8').trim().split('\n').length;
const beforeMtime = fs.statSync(claudeResult.filePath).mtimeMs;

await new Promise((r) => setTimeout(r, 20));
const extendedSession = {
  ...codexSession,
  messages: [...codexSession.messages, { role: 'user', text: 'and ship it', ts: Date.now() }],
};
const rewriteClaude = writeClaudeMirror(extendedSession, {
  existingSessionId: claudeResult.sessionId,
  existingFilePath: claudeResult.filePath,
});
const rewriteCodex = writeCodexMirror(extendedSession, {
  existingSessionId: codexResult.sessionId,
  existingFilePath: codexResult.filePath,
});

assert.equal(rewriteClaude.filePath, claudeResult.filePath, 'claude update must write same path');
assert.equal(rewriteCodex.filePath, codexResult.filePath, 'codex update must write same path');
assert.ok(fs.statSync(claudeResult.filePath).mtimeMs > beforeMtime, 'file should be rewritten');

const histLinesAfter = fs.readFileSync(PATHS.claudeHistory, 'utf8').trim().split('\n').length;
const idxLinesAfter = fs.readFileSync(PATHS.codexSessionIndex, 'utf8').trim().split('\n').length;
assert.equal(histLinesAfter, histLinesBefore, 'claude history.jsonl must NOT grow on update');
assert.equal(idxLinesAfter, idxLinesBefore, 'codex session_index.jsonl must NOT grow on update');

const rewritten = await readClaudeSession(claudeResult.filePath);
assert.equal(rewritten.isMirror, true, 'rewritten mirror still detected as mirror');
console.log('✓ update-in-place: same file path, mtime bumped, history/index NOT re-appended');

console.log('\nAll e2e checks passed.');
console.log(`Test artifacts preserved at: ${ROOT}`);
