# combobulate

Unify local chat memory across **Claude Code**, **Codex**, and **Cursor**.

Each desktop AI coding tool keeps its chat history in its own format on your disk.
If you ask Codex a question and want to pick the conversation up in Claude Code,
there's normally no way to do it — no shared history.

`combobulate` is a small macOS daemon that watches each tool's session storage
and mirrors new chats across the others. Open the same project in any of the
three tools and you'll see the chats you started elsewhere, with proper titles,
timestamps, and tool-call rendering native to that tool.

## Install

Requires **Node.js ≥ 22** (uses the built-in `node:sqlite` module) and **macOS**
(the daemon runs under launchd; Linux is a future port).

```bash
# from a clone
git clone https://github.com/<you>/combobulate ~/combobulate
cd ~/combobulate
npm install -g .
combobulate install
```

Or, once published:

```bash
npm install -g combobulator   # the npm package name (the `combobulate` bare
                              # name was already taken on npm — the CLI
                              # binary is still `combobulate`)
combobulate install
```

`combobulate install` writes a launchd plist at
`~/Library/LaunchAgents/com.combobulate.daemon.plist` and loads it. From now on,
every new chat in any of the three tools mirrors to the others within ~1.5s, and
the daemon restarts automatically on every login.

## What works

| Surface | Sync direction | How |
|---|---|---|
| Claude Code CLI (`claude /resume`) | read + write | direct file mirror under `~/.claude/projects/` |
| Claude Code VS Code extension | read + write | same files |
| Claude Code Cursor extension | read + write | same files |
| Codex CLI (`codex resume`) | read + write | direct rollout mirror under `~/.codex/sessions/` |
| Codex Desktop project sidebar | read + write | rollout + `codex app` IPC + `state_5.sqlite` row |
| Cursor | **read-only** | `state.vscdb` sqlite read |
| Claude Desktop "Claude Code" tab | not supported | cloud-backed, see Limitations |

## How it works

```
                   ┌──────────────┐
   Claude Code ──► │              │ ──► Claude Code
                   │  combobulate │
   Codex ────────► │   daemon     │ ──► Codex
                   │              │
   Cursor ───────► │  (poll @1.5s)│     Cursor (write deferred)
                   └──────────────┘
```

Every 1.5s the daemon scans:
- `~/.claude/projects/<encoded-cwd>/*.jsonl` — Claude Code sessions
- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — Codex rollouts
- `~/Library/Application Support/Cursor/.../state.vscdb` — Cursor's chat DB
  (opened read-only with `mode=ro&immutable=1` so we never contend with the
  running Cursor process)

For each session newer than the install epoch the daemon:

1. **Normalizes** it into a tool-agnostic typed event stream: real user prompts,
   assistant text responses, tool calls (with input/output), tool results.
2. **Detects mirrors** via a `__combobulate_mirror__` marker baked into every file
   we write, so we never re-mirror our own writes.
3. **Fingerprints** the message stream — skips if nothing has changed since the
   last sync. Same source updating? Overwrite the same mirror file in place.
4. **Emits** to each target tool's native format, including:
   - Per-turn `task_started` / `turn_context` / `user_message` / `reasoning` /
     `agent_message` / `task_complete` for Codex (the format Codex Desktop's
     renderer requires — wrong `phase` values or missing events make messages
     invisible).
   - Native `function_call` / `exec_command_end` / `function_call_output`
     events for tool calls (Bash → `exec_command`, Edit/Write/MultiEdit →
     `custom_tool_call name=apply_patch` with a unified diff).
   - Real per-message timestamps so the chat sorts under the date the original
     conversation happened.
   - A `[Claude Code]` / `[Codex]` / `[Cursor]` tag prepended to every mirrored
     thread title so you can see at a glance where a chat came from.

For Codex Desktop specifically, the daemon also:
- Calls `codex app <cwd>` so the project appears in Codex Desktop's sidebar.
- Inserts a row into `state_5.sqlite`'s `threads` table with `source='cli'`,
  non-zero `tokens_used`, and a non-empty `preview` — the threads with all three
  of those missing get filtered out of Codex Desktop's chat list as "empty drafts".

## Commands

```bash
combobulate install        # set up the launchd agent, start the daemon
combobulate uninstall      # remove the launchd agent (state in ~/.combobulate is kept)
combobulate daemon         # run the watcher in the foreground (used by launchd)
combobulate status         # quick state summary
combobulate doctor         # diagnose: daemon, paths, state, recent errors
combobulate sync           # one-shot mirror pass (doesn't need the daemon)
   --all                   # ignore the install epoch
   --since-hours=N         # default 24
   --limit=N               # max sessions per source, default 20
   --dry-run               # log what would mirror, write nothing
combobulate fix-codex-projects
                           # re-register all mirror cwds with Codex Desktop
combobulate cleanup        # remove broken Codex thread rows we created
   --dry-run               # list what would be deleted
combobulate help
```

**First-time troubleshooting**: run `combobulate doctor`. If it reports
problems, the message tells you the exact recovery command.

## Files combobulate touches

| Location | What |
|---|---|
| `~/.combobulate/state.json` | mirror tracking (source fingerprint → target ids/paths) |
| `~/.combobulate/daemon.log` | daemon log |
| `~/.combobulate/synced/` | fallback cwd for sourceless sessions (Cursor) |
| `~/Library/LaunchAgents/com.combobulate.daemon.plist` | launchd entry |
| `~/.claude/projects/<cwd>/<uuid>.jsonl` | mirrored Claude sessions |
| `~/.claude/history.jsonl` | up-arrow entries prefixed `[Codex]` / `[Cursor]` |
| `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | mirrored Codex rollouts |
| `~/.codex/state_5.sqlite` `threads` table | row per mirror so Codex Desktop renders it |
| `~/.codex/session_index.jsonl` | thread-index entry |
| `~/.codex/history.jsonl` | up-arrow entries prefixed `[Claude Code]` / `[Cursor]` |
| `~/.codex/.codex-global-state.json` | workspace-roots additions (one-time per cwd) |

Every mirrored Claude session has a `__combobulate_mirror__` marker on line 1.
Every mirrored Codex rollout has it nested at `session_meta.payload.combobulate`.
That's our loop-prevention key. To wipe all mirrors:

```bash
combobulate uninstall
grep -rl __combobulate_mirror__ ~/.claude/projects ~/.codex/sessions | xargs rm
combobulate cleanup    # remove dangling DB rows (still requires Node 22+)
rm -rf ~/.combobulate
```

## Known limitations

- **macOS only.** Daemon runs under launchd; Linux/systemd is a small port.
- **Cursor is read-only.** Cursor holds its 1.3GB `state.vscdb` open with a
  write lock while the app is running — injecting writes risks corruption.
  Cursor → others works fully; others → Cursor needs a Cursor extension that
  runs in-process.
- **Claude Desktop's "Claude Code" tab doesn't show synced chats.** That tab
  is cloud-backed — it lists sessions registered in `bridge-state.json` between
  a local CLI session and a claude.ai cloud session. Our mirrors are local-only
  files, so they never get bridged. The Claude Code CLI, the VS Code extension,
  and the Cursor extension all show synced chats correctly; only the
  Claude Desktop in-app tab is affected.
- **Codex Desktop's diff card** under an Edit/Write tool call shows
  "initialize a git repo" if the cwd isn't a git repo, and otherwise shows
  no diff if the file is already at the final state on disk. Codex's diff
  renderer reads the live working tree via `git diff`, not the unified diff
  embedded in the rollout — this is a Codex design choice.
- **Tool fidelity isn't 100% across tools.** Claude's `Read`/`Glob`/`Grep`/etc.
  are translated to Codex `exec_command` with a representative shell command;
  the surface looks right but the tool semantics don't perfectly match. Edit
  operations translate cleanly via `apply_patch`.

## Hacking / testing

```bash
npm test                       # runs test-e2e.mjs + test-daemon.mjs in a tmp HOME
COMBOBULATE_DEBUG=1 combobulate daemon
tail -f ~/.combobulate/daemon.log
```

The architecture (sources, sinks, daemon orchestrator) is documented in code.
The codex sink in particular has long comments capturing every format detail
we reverse-engineered the hard way — keep them in sync if Codex's format
shifts.

## License

MIT.
