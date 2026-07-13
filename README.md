# combobulator

Keep local coding chats in sync across Claude Code, Codex, and Cursor.

Combobulator runs as a small macOS background service. It watches each tool's
local session storage and writes new chats into the native history format used
by the other tools.

Start a chat in Codex, continue it in Claude Code, then reopen the original
Codex chat and see the continuation there too. The same flow works in the other
direction. Mirrored chats keep their project, title, messages, and timestamps.

## Requirements

- macOS
- Node.js 22 or newer

## Install

```bash
npm install -g combobulator
combobulator combobulate
```

`combobulator combobulate` starts the launchd agent and configures it to run after
login. Only chats created or updated after installation are synced by default.

To install from a local clone instead:

```bash
npm install -g .
combobulator combobulate
```

## Supported tools

| Tool | Support |
|---|---|
| Claude Code CLI and editor extensions | Read and write |
| Codex CLI and Codex Desktop | Read and write |
| Cursor chat | Read only |

Cursor chats can be mirrored into Claude Code and Codex. Combobulator does not
write chats into Cursor's database because Cursor keeps it locked while running.

Claude Desktop's cloud-backed "Claude Code" tab is not supported. Synced chats
are available through the Claude Code CLI and its VS Code or Cursor extensions.

## Commands

```bash
combobulator combobulate
combobulator stop
combobulator status
combobulator doctor
combobulator sync
combobulator discombobulate --all
```

- `combobulate` installs and starts the background service.
- `stop` stops and removes the background service. Sync state is preserved.
- `status` shows daemon, path, and recent sync information.
- `doctor` checks the installation and reports repair commands.
- `sync` runs a one-time sync without the daemon.
- `discombobulate --all` removes every mirrored chat and tracking record while
  preserving original Claude Code, Codex, and Cursor chats.

Useful one-time sync options:

```bash
combobulator sync --all --since-hours=24 --limit=20 --dry-run
```

Use `--all` to ignore the installation time, `--since-hours` to set the search
window, `--limit` to cap sessions per source, and `--dry-run` to preview changes.

Preview mirror removal before running it:

```bash
combobulator discombobulate --all --dry-run
```

## How syncing works

The daemon uses filesystem events instead of continuously polling. A slow
recovery scan catches dropped events or source directories created after the
daemon starts.

Combobulator marks every mirror it creates to prevent sync loops. When a mirror
is continued in Claude Code or Codex, the new transcript tail is written back
to the original chat only when the existing messages match exactly. Divergent
histories are left untouched rather than merged automatically.

Mirrored titles include `[Claude Code]`, `[Codex]`, or `[Cursor]` so their source
is visible in resume lists.

## Troubleshooting

Start with:

```bash
combobulator doctor
```

For Codex Desktop project-list problems, run:

```bash
combobulator fix-codex-projects
```

Daemon logs are stored at `~/.combobulator/daemon.log`.

## Development

```bash
npm test
COMBOBULATOR_DEBUG=1 combobulator daemon
```

The tests use temporary home directories and do not modify your real chat
history.

## License

MIT
