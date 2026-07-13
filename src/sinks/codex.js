import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, MIRROR_MARKER } from '../config.js';
import { registerCodexWorkspaceRoot } from '../codex-registry.js';
import { upsertCodexThread } from '../codex-thread-db.js';

// Generate a UUIDv7-ish string Codex would accept. Codex's session ids look like
// timestamp-millis hex + random; format is "xxxxxxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx".
function uuidv7() {
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, '0');
  const rand = crypto.randomBytes(10);
  // Set version (7) and variant bits.
  rand[0] = (rand[0] & 0x0f) | 0x70;
  rand[2] = (rand[2] & 0x3f) | 0x80;
  const r = rand.toString('hex');
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-${r.slice(0, 4)}-${r.slice(4, 8)}-${r.slice(8, 20)}`;
}

// Write a Codex rollout file that mirrors a UnifiedSession from another tool.
// Codex sessions live at ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl.
// We also append to ~/.codex/session_index.jsonl and ~/.codex/history.jsonl so the
// thread shows up in `codex resume` lists and up-arrow recall.
export function writeCodexMirror(session, { existingSessionId, existingFilePath } = {}) {
  const isUpdate = !!existingSessionId;
  const sessionId = existingSessionId || uuidv7();
  const cwd = session.cwd && session.cwd.startsWith('/') ? session.cwd : PATHS.combobulateSynced;
  fs.mkdirSync(cwd, { recursive: true });

  const now = new Date();
  const tsIso = now.toISOString();
  let filePath = existingFilePath;
  if (!filePath) {
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const dir = path.join(PATHS.codexSessions, yyyy, mm, dd);
    fs.mkdirSync(dir, { recursive: true });
    const isoFs = tsIso.replace(/[:.]/g, '-').slice(0, 19);
    filePath = path.join(dir, `rollout-${isoFs}-${sessionId}.jsonl`);
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  // Prepend a [<source>] tag to every mirrored thread title so you can tell at
  // a glance which tool a chat came from. Keep the raw snippet for firstUserMessage.
  const sourceLabel = sourceTag(session.source);
  const _rawTitle = session.threadName || firstUserSnippet(session) || 'Synced';
  const _threadNameForMarker = `${sourceLabel} ${_rawTitle}`.slice(0, 200);
  const _fumForMarker = (firstUserSnippet(session) || '').slice(0, 2000);

  // Build a rollout that *structurally* looks like one Codex's own CLI would write.
  //
  // The crucial detail (learned the hard way): each user turn is its own
  // task_started/task_complete pair with a fresh turn_id. If we lump all messages
  // under one task_started, Codex's UI renders the second+ user messages as
  // "steered conversation" — it thinks they're mid-turn redirects, not new turns.
  //
  // The loop-prevention marker hides inside session_meta.payload.combobulator so
  // Codex's parser doesn't reject the rollout (originator='combobulator' makes it
  // flip source to 'unknown').
  const lines = [];

  // Use the source session's createdAt for session_meta so the thread shows
  // up in Codex's "Recent" sort under the date the original conversation
  // started, not the date we ran the mirror.
  const sessionStartIso = session.createdAt ? new Date(session.createdAt).toISOString() : tsIso;

  lines.push(JSON.stringify({
    timestamp: sessionStartIso,
    type: 'session_meta',
    payload: {
      id: sessionId,
      timestamp: sessionStartIso,
      cwd,
      originator: 'Codex CLI',
      cli_version: '0.1.0',
      model_provider: 'openai',
      combobulator: {
        [MIRROR_MARKER]: true,
        mirrorOf: `${session.source}/${session.sessionId}`,
        mirroredAt: tsIso,
        title: _threadNameForMarker,
        firstUserMessage: _fumForMarker,
        sourceCwd: session.cwd || null,
      },
    },
  }));

  // Translate the source's typed event stream into native Codex events. Each
  // "turn" starts with a real user message and ends just before the next real
  // user message (or at the end of stream). Within a turn we may have
  // alternating assistant text + tool calls (each with its paired tool result),
  // mirroring how Codex's own CLI writes them.
  //
  // Tool translation:
  //   - Bash (or any shell-like Claude tool) → function_call name=exec_command
  //     + event_msg:exec_command_end + response_item:function_call_output
  //   - Edit / Write / MultiEdit → custom_tool_call name=apply_patch
  //     + event_msg:patch_apply_end (carries the unified diff that renders the
  //       little file-change card under the agent message) + custom_tool_call_output
  //   - Read / Glob / Grep / etc. → exec_command with a simulated command line
  //
  // Phase rules (Codex Desktop will silently drop messages with a bad phase):
  //   - phase = 'commentary' when the agent_message is followed by more work in
  //     this turn (more text or tool calls)
  //   - phase = 'final_answer' on the LAST agent_message of the turn — Codex
  //     keys "render this as the bottom bubble + diff card" off this value.
  const events = session.events || legacyEventsFromMessages(session.messages);
  const turns = groupEventsIntoTurns(events);
  let lastAgentMessage = '';
  let lastTs = session.createdAt || now.getTime();

  for (const turn of turns) {
    const turnId = uuidv7();
    const userTs = turn.events.find((e) => e.kind === 'user')?.ts || lastTs;
    const finalAgentTs = [...turn.events].reverse().find((e) => e.kind === 'assistant')?.ts
                       || turn.events[turn.events.length - 1]?.ts || userTs;
    const userIso = new Date(userTs).toISOString();
    const finalIso = new Date(finalAgentTs).toISOString();
    lastTs = finalAgentTs;

    lines.push(JSON.stringify({
      timestamp: userIso,
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: turnId,
        model_context_window: 258400,
        collaboration_mode_kind: 'default',
      },
    }));

    lines.push(JSON.stringify({
      timestamp: userIso,
      type: 'turn_context',
      payload: {
        turn_id: turnId,
        cwd,
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        model: 'gpt-5.5',
        effort: 'medium',
        summary: 'none',
      },
    }));

    // Emit the user-side first: combine any user_text events in this turn.
    const userParts = turn.events.filter((e) => e.kind === 'user').map((e) => e.text);
    const userText = userParts.join('\n\n');
    if (userText) {
      lines.push(JSON.stringify({
        timestamp: userIso,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] },
      }));
      lines.push(JSON.stringify({
        timestamp: userIso,
        type: 'event_msg',
        payload: { type: 'user_message', message: userText, images: [] },
      }));
    }

    // Emit the assistant-side events in their source order: text → tool call →
    // tool result → text → ... Determine which assistant text is the "final"
    // one (last one of the turn) so we can label its phase correctly.
    const assistantEventIdxs = turn.events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.kind === 'assistant')
      .map(({ i }) => i);
    const finalAssistantIdx = assistantEventIdxs[assistantEventIdxs.length - 1];

    // Index tool_results by callId so we can pair them up.
    const toolResults = new Map();
    for (const e of turn.events) {
      if (e.kind === 'tool_result' && e.callId) toolResults.set(e.callId, e);
    }

    for (let i = 0; i < turn.events.length; i++) {
      const e = turn.events[i];
      if (e.kind === 'user' || e.kind === 'tool_result') continue;
      const ts = new Date(e.ts).toISOString();

      if (e.kind === 'assistant') {
        const isFinal = i === finalAssistantIdx;
        const phase = isFinal ? 'final_answer' : 'commentary';

        // Reasoning stub before every agent_message — Codex's renderer expects it.
        lines.push(JSON.stringify({
          timestamp: ts,
          type: 'response_item',
          payload: { type: 'reasoning', summary: [], content: null, encrypted_content: '' },
        }));
        lines.push(JSON.stringify({
          timestamp: ts,
          type: 'event_msg',
          payload: { type: 'agent_message', message: e.text, phase, memory_citation: null },
        }));
        lines.push(JSON.stringify({
          timestamp: ts,
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: e.text }], phase },
        }));
        lastAgentMessage = e.text;
      } else if (e.kind === 'tool_call') {
        const result = toolResults.get(e.callId);
        emitToolCall(lines, { call: e, result, cwd, turnId, ts });
      }
    }

    // If a turn has no assistant text at all (rare — Claude usually responds),
    // still close with task_complete so Codex doesn't think the turn is open.
    lines.push(JSON.stringify({
      timestamp: finalIso,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: lastAgentMessage.slice(0, 2000),
        completed_at: Math.floor(finalAgentTs / 1000),
        duration_ms: Math.max(0, finalAgentTs - userTs),
      },
    }));
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n');

  // Only append to session_index + history on the FIRST mirror. Re-mirrors overwrite
  // the rollout in place. (Codex's UI dedups by id, but appending repeatedly bloats
  // history and shows duplicate entries in some views.)
  // Same tagged title for the threads-table title field and session_index entry.
  const threadName = `${sourceLabel} ${_rawTitle}`.slice(0, 80);
  const firstUserMessage = firstUserSnippet(session) || '';
  // Rough token estimate from the full transcript (~4 chars per token). Just
  // needs to be nonzero so Codex Desktop doesn't treat the thread as empty.
  const approxTokens = Math.max(1, Math.ceil(session.messages.reduce((n, m) => n + (m.text?.length || 0), 0) / 4));

  // Upsert the threads-table row on every mirror (first AND update). This is
  // what makes the chat visible in Codex Desktop's per-cwd sidebar. INSERT OR
  // REPLACE refreshes title/preview/tokens as the source grows. Use source
  // timestamps so the row sorts under the real chat date, not the mirror time.
  try {
    upsertCodexThread({
      sessionId,
      rolloutPath: filePath,
      cwd: session.cwd && session.cwd.startsWith('/') ? session.cwd : PATHS.combobulateSynced,
      title: threadName,
      firstUserMessage,
      createdAtMs: session.createdAt || now.getTime(),
      updatedAtMs: session.updatedAt || now.getTime(),
      approxTokens,
    });
  } catch {}

  if (!isUpdate) {
    // Ask Codex Desktop to register this cwd as a workspace root (via the
    // `codex app <path>` CLI, which IPCs the running app). Skipped if already
    // registered, so daemon-driven mirrors to known cwds don't steal focus.
    // Fire-and-forget — the mirror file + SQLite row are written regardless.
    if (session.cwd && session.cwd.startsWith('/')) {
      registerCodexWorkspaceRoot(session.cwd).catch(() => {});
    }

    fs.mkdirSync(path.dirname(PATHS.codexSessionIndex), { recursive: true });
    fs.appendFileSync(
      PATHS.codexSessionIndex,
      JSON.stringify({ id: sessionId, thread_name: threadName, updated_at: tsIso }) + '\n'
    );

    const lastUser = [...session.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      const label = `[from ${session.source}${session.threadName ? `: ${session.threadName}` : ''}] `;
      fs.mkdirSync(path.dirname(PATHS.codexHistory), { recursive: true });
      fs.appendFileSync(
        PATHS.codexHistory,
        JSON.stringify({
          session_id: sessionId,
          ts: Math.floor(now.getTime() / 1000),
          text: (label + lastUser.text).slice(0, 4000),
        }) + '\n'
      );
    }
  }

  return { sessionId, filePath };
}

// Human-readable label for the tool the mirror came from. Prepended to every
// title so Codex's chat list makes it obvious which tool originated the chat.
function sourceTag(source) {
  switch (source) {
    case 'claude': return '[Claude Code]';
    case 'cursor': return '[Cursor]';
    case 'codex':  return '[Codex]';
    default:       return `[${source || 'synced'}]`;
  }
}

// Fallback for sources that haven't been upgraded to emit the typed event
// stream (currently Cursor). Synthesizes a minimal user/assistant event list.
function legacyEventsFromMessages(messages) {
  return (messages || []).map((m) => ({ kind: m.role, text: m.text, ts: m.ts }));
}

// Group a typed event stream into Codex-shaped turns. A turn starts at a
// `user` event (real human prompt) and runs until just before the next `user`
// event. `tool_result` events stay with the turn that produced their matching
// `tool_call`, not with whatever user message technically delivered them in
// the source format.
function groupEventsIntoTurns(events) {
  const turns = [];
  let cur = null;
  for (const e of events) {
    if (e.kind === 'user') {
      if (cur) turns.push(cur);
      cur = { events: [e] };
    } else {
      if (!cur) cur = { events: [] };
      cur.events.push(e);
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

// Translate a single Claude tool_use + its paired tool_result into the right
// Codex events. Bash → exec_command, Edit/Write/MultiEdit → apply_patch with a
// proper unified_diff so Codex's UI renders the per-message diff card.
//
// The call_id format MATTERS: Codex Desktop's renderer links function_call to
// function_call_output by exact-matching `^call_[A-Za-z0-9]{20,}$`. If the id
// doesn't match the expected shape, the output never associates with the call
// and the expanded details panel shows nothing. We generate ids that fit.
function emitToolCall(lines, { call, result, cwd, turnId, ts }) {
  const callId = codexCallId();
  const tool = call.tool || 'unknown';
  const isEdit = /^(Edit|MultiEdit|Write|NotebookEdit)$/i.test(tool);

  if (isEdit) {
    const { patch, diffs, filePath } = renderApplyPatch(tool, call.input);
    lines.push(JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'apply_patch', input: patch },
    }));
    const rawOut = result?.output || `Success. Updated the following files:\nM ${filePath || '(unknown)'}`;
    lines.push(JSON.stringify({
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: callId,
        turn_id: turnId,
        stdout: rawOut,
        stderr: '',
        success: !(result?.isError),
        changes: diffs,
        status: 'completed',
      },
    }));
    lines.push(JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: callId,
        output: JSON.stringify({ output: rawOut, metadata: { exit_code: result?.isError ? 1 : 0, duration_seconds: 0 } }),
      },
    }));
  } else {
    const cmd = renderExecCommand(tool, call.input);
    const args = JSON.stringify({ cmd, workdir: cwd, yield_time_ms: 1000, max_output_tokens: 10000 });
    lines.push(JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: args, call_id: callId },
    }));
    const rawOut = result?.output || '';
    lines.push(JSON.stringify({
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        call_id: callId,
        process_id: '0',
        turn_id: turnId,
        command: ['/bin/zsh', '-lc', cmd],
        cwd,
        parsed_cmd: [{ type: 'unknown', cmd }],
        source: 'unified_exec_startup',
        stdout: '',
        stderr: '',
        aggregated_output: rawOut,
        exit_code: result?.isError ? 1 : 0,
        duration: { secs: 0, nanos: 0 },
        formatted_output: '',
        status: 'completed',
      },
    }));
    // Wrap the function_call_output payload in Codex's standard envelope so
    // the details panel renders the structured Chunk-ID / Process-exited /
    // Output: header it expects.
    lines.push(JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: callId,
        output: formatCodexExecOutput(rawOut, result?.isError ? 1 : 0),
      },
    }));
  }
}

// Build the Codex-style function_call_output text envelope that the Desktop
// renderer parses to populate the expanded tool-output panel.
function formatCodexExecOutput(text, exitCode) {
  const chunkId = Math.random().toString(36).slice(2, 8);
  const tokens = Math.max(1, Math.ceil((text || '').length / 4));
  return `Chunk ID: ${chunkId}\nWall time: 0.0000 seconds\nProcess exited with code ${exitCode}\nOriginal token count: ${tokens}\nOutput:\n${text}`;
}

// Generate a call_id in Codex's expected shape: `call_` + 24 base62 chars.
function codexCallId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = 'call_';
  for (let i = 0; i < 24; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Compose a Codex-style apply_patch input from Claude's Edit-family tool args.
// Returns the V4A patch string + a `changes` dict for patch_apply_end.
function renderApplyPatch(tool, input) {
  input = input || {};
  const filePath = input.file_path || input.path || input.notebook_path || '(unknown file)';

  if (/^MultiEdit$/i.test(tool) && Array.isArray(input.edits)) {
    let patch = `*** Begin Patch\n*** Update File: ${filePath}\n`;
    const diffHunks = [];
    for (const ed of input.edits) {
      patch += '@@\n';
      patch += unifiedHunkFromEdit(ed.old_string || '', ed.new_string || '');
      diffHunks.push(unifiedHunkFromEdit(ed.old_string || '', ed.new_string || ''));
    }
    patch += '*** End Patch';
    return {
      patch,
      filePath,
      diffs: { [filePath]: { type: 'update', unified_diff: diffHunks.join(''), move_path: null } },
    };
  }

  if (/^Write$/i.test(tool)) {
    const content = input.content || '';
    const lines = content.split('\n');
    const diff = lines.map((l) => `+${l}`).join('\n');
    return {
      patch: `*** Begin Patch\n*** Add File: ${filePath}\n${diff}\n*** End Patch`,
      filePath,
      diffs: { [filePath]: { type: 'add', unified_diff: `@@\n${diff}\n`, move_path: null } },
    };
  }

  // Edit (single-edit). NotebookEdit uses similar shape.
  const oldStr = input.old_string || '';
  const newStr = input.new_string || '';
  const hunk = unifiedHunkFromEdit(oldStr, newStr);
  return {
    patch: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n${hunk}*** End Patch`,
    filePath,
    diffs: { [filePath]: { type: 'update', unified_diff: hunk, move_path: null } },
  };
}

// Convert an Edit's (old_string, new_string) into a minimal unified-diff hunk.
// No surrounding context — Codex's renderer just needs the +/- lines to show
// the change card under the agent message.
function unifiedHunkFromEdit(oldStr, newStr) {
  const oldLines = oldStr.split('\n').map((l) => `-${l}`);
  const newLines = newStr.split('\n').map((l) => `+${l}`);
  return [...oldLines, ...newLines].join('\n') + '\n';
}

// Synthesize a shell command for non-Bash Claude tools so the exec_command
// rendering reads like a real terminal invocation rather than "[tool: Glob]".
function renderExecCommand(tool, input) {
  input = input || {};
  switch (tool) {
    case 'Bash':       return input.command || input.cmd || '';
    case 'Read':       return `cat ${input.file_path || ''}`.trim();
    case 'Glob':       return `find . -path '${input.pattern || ''}'`;
    case 'Grep': {
      const pattern = JSON.stringify(input.pattern || '');
      const path_ = input.path ? ` ${input.path}` : '';
      return `rg ${pattern}${path_}`;
    }
    case 'WebFetch':   return `curl -L ${input.url || ''}`;
    case 'WebSearch':  return `# search: ${input.query || ''}`;
    default: {
      // Generic fallback: tool name + JSON-ish args, kept short.
      const summary = JSON.stringify(input).slice(0, 200);
      return `# ${tool} ${summary}`;
    }
  }
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 14);
}

// Group the normalized message stream into Codex-shaped turns. A "turn" is
// (optional user, optional assistant). Consecutive same-role messages get
// concatenated so each transitions user→assistant→user creates a new turn,
// matching how Codex thinks about the conversation.
//
// Each turn also carries the source timestamp of its first user and first
// assistant message so the rollout's per-event timestamps reflect when the
// original conversation actually happened (not when we mirrored it).
function groupIntoTurns(messages) {
  const turns = [];
  let cur = null;
  let lastRole = null;
  for (const m of messages) {
    if (!m.text) continue;
    if (m.role === 'user') {
      if (cur && lastRole === 'assistant') {
        turns.push(cur);
        cur = null;
      }
      if (!cur) cur = { user: '', userTs: null, assistant: '', assistantTs: null };
      cur.user = cur.user ? cur.user + '\n\n' + m.text : m.text;
      if (!cur.userTs && m.ts) cur.userTs = m.ts;
      lastRole = 'user';
    } else if (m.role === 'assistant') {
      if (!cur) cur = { user: '', userTs: null, assistant: '', assistantTs: null };
      cur.assistant = cur.assistant ? cur.assistant + '\n\n' + m.text : m.text;
      if (!cur.assistantTs && m.ts) cur.assistantTs = m.ts;
      lastRole = 'assistant';
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

// Pick a clean title for the synced chat. Skip Claude Code's IDE-injected
// preambles (<ide_opened_file>...), system reminders, environment dumps,
// and the like — those make terrible thread names. Use the first user
// message that looks like an actual human prompt.
function firstUserSnippet(session) {
  const looksInjected = (text) =>
    /^\s*<(ide_opened_file|system-reminder|command-(name|message)|environment_context|local-command-stdout|command-stderr)\b/i.test(text) ||
    /^\s*\[Pasted text/.test(text);

  for (const m of session.messages) {
    if (m.role !== 'user') continue;
    if (looksInjected(m.text)) continue;
    return m.text.split('\n').find((l) => l.trim()).slice(0, 80);
  }
  // fallback: any user message at all
  const u = session.messages.find((m) => m.role === 'user');
  return u ? u.text.split('\n')[0].slice(0, 80) : null;
}

function renderTranscript(session) {
  const header =
    `[Synced from ${session.source}${session.threadName ? `: ${session.threadName}` : ''} via combobulator]\n` +
    `Source session: ${session.sessionId}\n` +
    (session.cwd ? `Source cwd: ${session.cwd}\n` : '') +
    `Synced: ${new Date().toISOString()}\n\n` +
    `Below is the prior conversation. Continue from where it left off.\n` +
    `---\n`;
  const body = session.messages
    .map((m) => `**${m.role === 'user' ? 'User' : 'Assistant'}:** ${m.text}`)
    .join('\n\n');
  return header + body;
}
