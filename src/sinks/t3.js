import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PATHS, resolveT3Db, resolveUserPath } from '../config.js';

const DEFAULT_MODEL_SELECTION = { instanceId: 'codex', model: 'gpt-5' };

// Older T3 builds are event-sourced: write orchestration_events and let the
// projector fill projection_*. T3 Code beta reads orchestration_v2_* and, on
// startup, imports leftover projection_threads / projection_thread_messages
// itself. Writing the v2 tables directly is not enough, and writing the old
// thread.message-sent events does not show up in the beta sidebar.
export function writeT3Mirror(session, { existingSessionId, workspace } = {}) {
  const dbPath = resolveT3Db();
  if (!dbPath) {
    throw new Error('T3 database not found (~/.t3/userdata/statev2.sqlite or state.sqlite). Set COMBOBULATOR_T3_DB to override.');
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  try {
    db.exec('BEGIN IMMEDIATE');
    const projectCwd = outputWorkspace(session, workspace);
    const result = isBeta(db)
      ? writeBetaProjection(db, session, { existingSessionId, projectCwd })
      : writeLegacyEvents(db, session, { existingSessionId, projectCwd });
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already closed or not in a transaction */ }
    throw error;
  } finally {
    db.close();
  }
}

function outputWorkspace(session, workspace) {
  return absolute(workspace)
    || absolute(process.env.COMBOBULATOR_T3_WORKSPACE)
    || absolute(session.cwd)
    || PATHS.combobulateSynced;
}

function absolute(value) {
  const resolved = resolveUserPath(typeof value === 'string' ? value.trim() : '');
  return resolved?.startsWith('/') ? resolved : null;
}

function isBeta(db) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='orchestration_v2_projection_threads'`).get();
}

function writeBetaProjection(db, session, { existingSessionId, projectCwd }) {
  const project = findOrCreateProject(db, projectCwd, session.createdAt, { beta: true });
  const threadId = existingSessionId || crypto.randomUUID();
  const title = threadTitle(session, projectCwd);
  const createdAt = iso(session.createdAt);
  const updatedAt = iso(session.updatedAt || session.createdAt);
  const modelJson = JSON.stringify(project.modelSelection || DEFAULT_MODEL_SELECTION);
  const messages = (session.messages || []).filter((message) => message.text && ['user', 'assistant'].includes(message.role));
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const base = Number(session.createdAt) || Date.now();

  db.prepare(`INSERT INTO projection_threads (
      thread_id, project_id, title, created_at, updated_at,
      runtime_mode, interaction_mode, model_selection_json, latest_user_message_at
    ) VALUES (?, ?, ?, ?, ?, 'full-access', 'default', ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      project_id = excluded.project_id,
      title = excluded.title,
      updated_at = excluded.updated_at,
      model_selection_json = excluded.model_selection_json,
      latest_user_message_at = excluded.latest_user_message_at
  `).run(threadId, project.id, title, createdAt, updatedAt, modelJson, lastUser ? iso(base + messages.lastIndexOf(lastUser)) : null);

  db.prepare(`DELETE FROM projection_thread_messages WHERE thread_id = ?`).run(threadId);
  const insert = db.prepare(`INSERT INTO projection_thread_messages (
      message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json
    ) VALUES (?, ?, ?, ?, 0, ?, ?, '[]')`);
  messages.forEach((message, index) => {
    const at = iso(base + index);
    insert.run(messageId(threadId, index), threadId, message.role, message.text, at, at);
  });
  return { sessionId: threadId, filePath: `t3:${threadId}`, beta: true };
}

function writeLegacyEvents(db, session, { existingSessionId, projectCwd }) {
  const project = findOrCreateProject(db, projectCwd, session.createdAt, { beta: false });
  const threadId = existingSessionId || crypto.randomUUID();
  const title = threadTitle(session, projectCwd);
  const modelSelection = project.modelSelection || DEFAULT_MODEL_SELECTION;
  if (!legacyThreadExists(db, threadId)) {
    const createdAt = iso(session.createdAt);
    appendEvent(db, {
      aggregateKind: 'thread',
      streamId: threadId,
      type: 'thread.created',
      occurredAt: createdAt,
      payload: {
        threadId,
        projectId: project.id,
        title,
        modelSelection,
        runtimeMode: 'full-access',
        interactionMode: 'default',
        branch: null,
        worktreePath: null,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
  const existingCount = Number(db.prepare(`SELECT count(*) AS n FROM orchestration_events WHERE stream_id=? AND event_type='thread.message-sent'`).get(threadId)?.n || 0);
  for (const [index, message] of (session.messages || []).entries()) {
    if (index < existingCount || !message.text || !['user', 'assistant'].includes(message.role)) continue;
    const createdAt = iso(message.ts || session.createdAt);
    appendEvent(db, {
      aggregateKind: 'thread',
      streamId: threadId,
      type: 'thread.message-sent',
      occurredAt: createdAt,
      payload: {
        threadId,
        messageId: crypto.randomUUID(),
        role: message.role,
        text: message.text,
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
  return { sessionId: threadId, filePath: `t3:${threadId}` };
}

function findOrCreateProject(db, cwd, timestamp, { beta }) {
  const projected = db.prepare(`SELECT project_id AS id, default_model_selection_json AS model FROM projection_projects WHERE workspace_root=? AND deleted_at IS NULL LIMIT 1`).get(cwd);
  if (projected) return { id: projected.id, modelSelection: parseModel(projected.model) };
  if (!beta) {
    const event = db.prepare(`SELECT payload_json AS payload FROM orchestration_events WHERE event_type='project.created' AND json_extract(payload_json,'$.workspaceRoot')=? ORDER BY sequence DESC LIMIT 1`).get(cwd);
    if (event) {
      const payload = JSON.parse(event.payload);
      return { id: payload.projectId, modelSelection: payload.defaultModelSelection || DEFAULT_MODEL_SELECTION };
    }
  }
  const projectId = crypto.randomUUID();
  const createdAt = iso(timestamp);
  const title = path.basename(cwd) || 'Synced project';
  if (beta && db.prepare(`SELECT 1 FROM pragma_table_info('projection_projects') WHERE name='scripts_json'`).get()) {
    db.prepare(`INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, default_model_selection_json, auto_pull
      ) VALUES (?, ?, ?, '[]', ?, ?, ?, 0)`).run(projectId, title, cwd, createdAt, createdAt, JSON.stringify(DEFAULT_MODEL_SELECTION));
  }
  appendEvent(db, {
    aggregateKind: 'project',
    streamId: projectId,
    type: 'project.created',
    occurredAt: createdAt,
    applicationEventVersion: beta ? 2 : 1,
    payload: {
      projectId,
      title,
      workspaceRoot: cwd,
      defaultModelSelection: DEFAULT_MODEL_SELECTION,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  return { id: projectId, modelSelection: DEFAULT_MODEL_SELECTION };
}

function appendEvent(db, { aggregateKind, streamId, type, occurredAt, payload, applicationEventVersion = 1 }) {
  const hasVersion = !!db.prepare(`SELECT 1 FROM pragma_table_info('orchestration_events') WHERE name='application_event_version'`).get();
  if (hasVersion) {
    db.prepare(`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json,
        application_event_version
      ) VALUES (
        ?, ?, ?, COALESCE((SELECT max(stream_version)+1 FROM orchestration_events WHERE aggregate_kind=? AND stream_id=?), 0),
        ?, ?, NULL, NULL, NULL, 'server', ?, '{}', ?
      )`).run(crypto.randomUUID(), aggregateKind, streamId, aggregateKind, streamId, type, occurredAt, JSON.stringify(payload), applicationEventVersion);
    return;
  }
  db.prepare(`INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
    ) VALUES (
      ?, ?, ?, COALESCE((SELECT max(stream_version)+1 FROM orchestration_events WHERE aggregate_kind=? AND stream_id=?), 0),
      ?, ?, NULL, NULL, NULL, 'server', ?, '{}'
    )`).run(crypto.randomUUID(), aggregateKind, streamId, aggregateKind, streamId, type, occurredAt, JSON.stringify(payload));
}

function legacyThreadExists(db, threadId) {
  return !!db.prepare(`SELECT 1 FROM orchestration_events WHERE stream_id=? AND event_type='thread.created' LIMIT 1`).get(threadId);
}

function messageId(threadId, index) {
  const hex = crypto.createHash('sha256').update(`${threadId}:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function threadTitle(session, projectCwd) {
  const raw = `${sourceTag(session.source)} ${session.threadName || firstUserSnippet(session) || 'Synced chat'}`;
  const sourceCwd = absolute(session.cwd);
  const suffix = sourceCwd && path.resolve(sourceCwd) !== path.resolve(projectCwd) ? ` (${path.basename(sourceCwd)})` : '';
  return `${raw}${suffix}`.slice(0, 200);
}

function parseModel(value) { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function iso(value) { const d = new Date(value || Date.now()); return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); }
function firstUserSnippet(session) { return session.messages?.find((m) => m.role === 'user')?.text?.replace(/\s+/g, ' ').slice(0, 100); }
function sourceTag(source) { return source === 'claude' ? '[Claude Code]' : source === 'codex' ? '[Codex]' : source === 'cursor' ? '[Cursor]' : `[${source}]`; }
