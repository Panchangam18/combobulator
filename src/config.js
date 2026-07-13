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

  combobulateDir: path.join(HOME, '.combobulate'),
  combobulateState: path.join(HOME, '.combobulate', 'state.json'),
  combobulateLog: path.join(HOME, '.combobulate', 'daemon.log'),
  combobulatePid: path.join(HOME, '.combobulate', 'daemon.pid'),
  combobulateSynced: path.join(HOME, '.combobulate', 'synced'),
  launchdPlist: path.join(HOME, 'Library', 'LaunchAgents', 'com.combobulate.daemon.plist'),
};

export const LAUNCHD_LABEL = 'com.combobulate.daemon';

export const POLL_INTERVAL_MS = 1500;

// Mirror marker — embedded in every synced session so we don't mirror our own writes.
export const MIRROR_MARKER = '__combobulate_mirror__';

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
