import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();

export const PATHS = {
  claudeDir: path.join(HOME, '.claude'),
  claudeProjects: path.join(HOME, '.claude', 'projects'),
  claudeHistory: path.join(HOME, '.claude', 'history.jsonl'),

  codexDir: path.join(HOME, '.codex'),
  codexSessions: path.join(HOME, '.codex', 'sessions'),
  codexSessionIndex: path.join(HOME, '.codex', 'session_index.jsonl'),
  codexHistory: path.join(HOME, '.codex', 'history.jsonl'),

  cursorDb: path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  t3Dir: path.join(HOME, '.t3'),
  t3Db: path.join(HOME, '.t3', 'userdata', 'state.sqlite'),

  combobulateDir: path.join(HOME, '.combobulator'),
  combobulateState: path.join(HOME, '.combobulator', 'state.json'),
  combobulateLog: path.join(HOME, '.combobulator', 'daemon.log'),
  combobulatePid: path.join(HOME, '.combobulator', 'daemon.pid'),
  combobulateSynced: path.join(HOME, '.combobulator', 'synced'),
  launchdPlist: path.join(HOME, 'Library', 'LaunchAgents', 'com.combobulator.daemon.plist'),
  legacyCombobulateState: path.join(HOME, '.combobulate', 'state.json'),
  legacyLaunchdPlist: path.join(HOME, 'Library', 'LaunchAgents', 'com.combobulate.daemon.plist'),
};

// Android platform-tools ships a sqlite3 that fails to load libc++ on this Mac.
// Prefer the OS binary when it is present.
export const SQLITE_BIN = process.platform === 'darwin' && fs.existsSync('/usr/bin/sqlite3')
  ? '/usr/bin/sqlite3'
  : 'sqlite3';

export const LAUNCHD_LABEL = 'com.combobulator.daemon';
export const LEGACY_LAUNCHD_LABEL = 'com.combobulate.daemon';

// File events drive normal syncing. The slow scan recovers from dropped events,
// watcher restarts, and source directories that appear after daemon startup.
export const WATCH_DEBOUNCE_MS = 250;
export const RECOVERY_SCAN_INTERVAL_MS = 60_000;

// Mirror marker — embedded in every synced session so we don't mirror our own writes.
export const MIRROR_MARKER = '__combobulator_mirror__';
export const LEGACY_MIRROR_MARKER = '__combobulate_mirror__';

export function isMirrorMarker(record) {
  return !!(record?.[MIRROR_MARKER] || record?.[LEGACY_MIRROR_MARKER]);
}

const IGNORED_CWD_PREFIXES = [
  path.join(HOME, 'Library', 'Application Support', 'CodexBar', 'ClaudeProbe'),
];

export function isIgnoredCwd(cwd) {
  if (!cwd || !cwd.startsWith('/')) return false;
  const normalized = path.normalize(cwd);
  return IGNORED_CWD_PREFIXES.some((ignored) => (
    normalized === ignored || normalized.startsWith(`${ignored}${path.sep}`)
  ));
}

// Encode an absolute filesystem path the way Claude Code does for ~/.claude/projects/<encoded>/.
// Claude replaces every '/' (and leading slash) with '-' and drops the leading dash on root.
// E.g. /Users/madhavan/foo -> -Users-madhavan-foo
export function encodeClaudeProjectDir(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

// T3 Code beta stores chats in statev2.sqlite. Older builds used state.sqlite.
// COMBOBULATOR_T3_DB overrides both. Returns null when neither file exists so
// callers do not create an empty database the app will ignore.
export function resolveT3Db() {
  const override = process.env.COMBOBULATOR_T3_DB?.trim();
  if (override) return resolveUserPath(override);
  const dir = path.join(HOME, '.t3', 'userdata');
  const beta = path.join(dir, 'statev2.sqlite');
  const legacy = path.join(dir, 'state.sqlite');
  if (fs.existsSync(beta)) return beta;
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

export function resolveUserPath(value) {
  if (!value) return null;
  const expanded = value.startsWith('~') ? path.join(HOME, value.slice(1)) : value;
  return path.resolve(expanded);
}

// PATH-delimited lists, e.g. COMBOBULATOR_CURSOR_WORKSPACES=/a:/b
export function splitList(value) {
  if (!value || value === true) return [];
  return String(value).split(path.delimiter).map((part) => part.trim()).filter(Boolean);
}
