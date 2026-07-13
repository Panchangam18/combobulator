import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, MIRROR_MARKER, encodeClaudeProjectDir } from '../config.js';

// Convert a UnifiedSession from another tool (Codex / Cursor / …) into a
// Claude Code session file that resumes cleanly in Claude Code's /resume UI.
//
// What we emit:
//   - line 1: the loop-prevention marker (top-level field; Claude ignores it)
//   - line 2: an `ai-title` event so the synced chat shows up under a
//     human-readable name like "[Codex] <thread name>" instead of the first
//     user message snippet
//   - one user / assistant pair per source turn, each with the original
//     per-message timestamp so the conversation timeline is preserved
//   - tool-call events from the source aren't replayed natively (Claude and
//     Codex have incompatible tool formats); we drop them — the agent text
//     either side of a tool call carries enough context to continue the chat
export function writeClaudeMirror(session, { existingSessionId, existingFilePath } = {}) {
  const cwd = session.cwd && session.cwd.startsWith('/') ? session.cwd : PATHS.combobulateSynced;
  fs.mkdirSync(cwd, { recursive: true });

  const projDir = path.join(PATHS.claudeProjects, encodeClaudeProjectDir(cwd));
  fs.mkdirSync(projDir, { recursive: true });

  const isUpdate = !!existingSessionId;
  const sessionId = existingSessionId || crypto.randomUUID();
  // Claude's filename is deterministic from sessionId+cwd, so reusing sessionId
  // alone makes the rewrite hit the same path. existingFilePath is honored if given.
  const filePath = existingFilePath || path.join(projDir, `${sessionId}.jsonl`);

  const sourceLabel = sourceTag(session.source);
  const rawTitle = session.threadName || firstUserSnippet(session) || 'Synced chat';
  const taggedTitle = `${sourceLabel} ${rawTitle}`.slice(0, 200);
  const sessionStartIso = session.createdAt
    ? new Date(session.createdAt).toISOString()
    : new Date().toISOString();

  const lines = [];

  // Loop-prevention marker — readers detect this and skip the file as a source.
  lines.push(JSON.stringify({
    [MIRROR_MARKER]: true,
    mirrorOf: `${session.source}/${session.sessionId}`,
    mirroredAt: new Date().toISOString(),
    sourceCwd: session.cwd || null,
    title: taggedTitle,
  }));

  // Replay each turn from the source as native Claude user/assistant messages
  // with their original timestamps. Skip tool_call / tool_result events — we
  // can't faithfully translate them to Claude's tool format.
  let parentUuid = null;
  let lastTs = session.createdAt || Date.now();
  const messages = (session.events || legacyEvents(session.messages || []))
    .filter((e) => e.kind === 'user' || e.kind === 'assistant');

  for (const m of messages) {
    if (!m.text) continue;
    const ts = m.ts || lastTs;
    lastTs = ts;
    const iso = new Date(ts).toISOString();
    const uuid = crypto.randomUUID();

    if (m.kind === 'user') {
      lines.push(JSON.stringify({
        parentUuid,
        isSidechain: false,
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: m.text }],
        },
        uuid,
        timestamp: iso,
        userType: 'external',
        entrypoint: 'combobulator',
        cwd,
        sessionId,
        version: '2.1.111',
      }));
    } else {
      lines.push(JSON.stringify({
        parentUuid,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: `claude-mirror-from-${session.source}`,
          id: `msg_${uuid.replace(/-/g, '').slice(0, 24)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: m.text }],
        },
        uuid,
        timestamp: iso,
        sessionId,
      }));
    }
    parentUuid = uuid;
  }

  // Emit ai-title AFTER the conversation messages — Claude Code's /resume
  // picker reads the LAST ai-title event in the file (Claude itself rewrites
  // ai-title throughout a session as the conversation evolves). Putting ours
  // at the top makes it ignored; putting it at the end makes it authoritative.
  lines.push(JSON.stringify({
    type: 'ai-title',
    aiTitle: taggedTitle,
    sessionId,
  }));

  fs.writeFileSync(filePath, lines.join('\n') + '\n');

  // Only append to ~/.claude/history.jsonl on the FIRST mirror — re-mirroring
  // should overwrite the session file in place, not spam up-arrow recall.
  if (!isUpdate) {
    const lastUser = [...messages].reverse().find((m) => m.kind === 'user');
    if (lastUser) {
      appendClaudeHistory({ text: lastUser.text, cwd, sourceLabel });
    }
  }

  return { sessionId, filePath };
}

function appendClaudeHistory({ text, cwd, sourceLabel }) {
  fs.mkdirSync(path.dirname(PATHS.claudeHistory), { recursive: true });
  const entry = {
    display: `${sourceLabel} ${text}`.slice(0, 4000),
    pastedContents: {},
    timestamp: Date.now(),
    project: cwd,
  };
  fs.appendFileSync(PATHS.claudeHistory, JSON.stringify(entry) + '\n');
}

// Human-readable label for the tool the mirror came from — keep this in sync
// with the codex sink's sourceTag so titles look consistent across the system.
function sourceTag(source) {
  switch (source) {
    case 'claude': return '[Claude Code]';
    case 'cursor': return '[Cursor]';
    case 'codex':  return '[Codex]';
    default:       return `[${source || 'synced'}]`;
  }
}

// Pick a clean first-user-prompt snippet for the fallback title. Skip Codex/
// Claude system-injected preambles that aren't real user input.
function firstUserSnippet(session) {
  const ev = (session.events || legacyEvents(session.messages || []));
  for (const e of ev) {
    if (e.kind !== 'user' || !e.text) continue;
    const body = e.text.trim();
    if (/^<environment_context>/i.test(body)) continue;
    if (/^<(ide_opened_file|system-reminder|command-(name|message))/i.test(body)) continue;
    return body.split('\n').find((l) => l.trim())?.slice(0, 80) || null;
  }
  return null;
}

// Sources that haven't been upgraded to the typed event stream emit just
// `messages: [{role, text, ts}]`. Synthesize an equivalent event list.
function legacyEvents(messages) {
  return messages.map((m) => ({ kind: m.role, text: m.text, ts: m.ts }));
}
