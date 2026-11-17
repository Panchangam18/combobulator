import { combobulate } from './commands/install.js';
import { stop } from './commands/uninstall.js';
import { status } from './commands/status.js';
import { sync } from './commands/sync.js';
import { fixCodexProjects } from './commands/fix-codex-projects.js';
import { cleanup } from './commands/cleanup.js';
import { doctor } from './commands/doctor.js';
import { runDaemon } from './daemon.js';

const HELP = `combobulator — unify chat history across Claude Code, Codex, and Cursor

USAGE
  combobulator <command> [options]

COMMANDS
  combobulate       Set up the background daemon (launchd agent on macOS) and
                    start mirroring new sessions from now on.
  stop              Stop and remove the launchd agent. Sync state is kept.
  daemon            Run the watcher in the foreground (used by launchd).
  status            Show what's installed, last mirrored sessions, watched paths.
  sync [opts]       One-shot mirror pass over recent sessions.
                    --all                ignore service start time
                    --since-hours=N      look back N hours (default 24)
                    --limit=N            max sessions per source (default 20).
                                         With --cursor-workspace, the cap applies
                                         after the workspace filter.
                    --dry-run            log what would be mirrored, write nothing
                    --only=t3            comma list of sinks: claude,codex,t3
                    --t3-workspace=PATH  put every mirrored chat in this T3 project.
                                         Repeatable input filters still choose which
                                         Cursor workspaces are read.
                    --cursor-workspace=PATH
                                         only Cursor chats from this workspace.
                                         Repeat the flag for more workspaces.
                    --cursor-workspace-prefix=PATH
                                         this workspace and its child directories.
  fix-codex-projects
                    Register every cwd from existing mirrors in Codex Desktop's
                    workspace list. Called automatically by combobulate; rerun if
                    Codex stopped surfacing a synced project.
  discombobulate [--dry-run] [--all]
                    Remove broken Codex thread rows we created (source='unknown'
                    or orphaned). Safe — won't touch your real threads or
                    rollout files.
                    --all removes every mirrored chat and tracking record.
  doctor            Diagnose the setup: daemon, paths, state, recent errors.
                    Run this first when sync isn't working.
  help              Show this message.

How it works
  Daemon uses macOS filesystem events to detect session changes. New chats get mirrored
  to the other tools' native formats: per-turn replay with proper task_started
  / agent_message / tool calls, real timestamps, and a [Source] tag prepended
  to the title. Mirrored files are tagged so we never replay our own writes.

  Cursor is read-only — its sqlite chat DB is locked while the app runs.
  Claude Desktop's "Claude Code" tab is cloud-backed and out of scope; the
  Claude CLI, VS Code extension, Cursor extension, Codex CLI, and Codex Desktop
  all see the synced chats. Run \`combobulator doctor\` if something looks off.
`;

const REPEATABLE = new Set(['cursor-workspace', 'cursor-workspace-prefix']);

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split('=');
      const value = v === undefined ? true : v;
      if (REPEATABLE.has(k)) {
        const current = out[k];
        out[k] = current === undefined ? [value] : [...current, value];
      } else {
        out[k] = value;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function asList(value) {
  if (!value || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0] || 'help';

  switch (cmd) {
    case 'combobulate':
    case 'install': return combobulate();
    case 'stop':
    case 'uninstall': return stop();
    case 'daemon':     return runDaemon();
    case 'status':     return status();
    case 'fix-codex-projects': return fixCodexProjects();
    case 'discombobulate': return cleanup({ dryRun: !!args['dry-run'], all: !!args.all });
    case 'doctor': return doctor();
    case 'sync':
      return sync({
        all: !!args.all,
        sinceHours: args['since-hours'] ? Number(args['since-hours']) : 24,
        limit: args.limit ? Number(args.limit) : 20,
        dryRun: !!args['dry-run'],
        only: args.only && args.only !== true ? String(args.only).split(',').map((part) => part.trim()).filter(Boolean) : null,
        t3Workspace: args['t3-workspace'] && args['t3-workspace'] !== true ? args['t3-workspace'] : null,
        cursorWorkspaces: asList(args['cursor-workspace']),
        cursorWorkspacePrefixes: asList(args['cursor-workspace-prefix']),
      });
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}
