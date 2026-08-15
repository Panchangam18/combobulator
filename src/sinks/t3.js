import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PATHS } from '../config.js';

const DEFAULT_MODEL_SELECTION = { instanceId: 'codex', model: 'gpt-5' };

// T3 Code is event-sourced. Write canonical events and let T3's projector own
// the projection_* tables; writing those views directly is lost on a rebuild.
export function writeT3Mirror(session, { existingSessionId } = {}) {
  fs.mkdirSync(path.dirname(PATHS.t3Db), { recursive: true });
  const db = new DatabaseSync(PATHS.t3Db);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  try {
    db.exec('BEGIN IMMEDIATE');
    const cwd = session.cwd?.startsWith('/') ? session.cwd : PATHS.combobulateSynced;
    const project = findOrCreateProject(db, cwd, session.createdAt);
    const threadId = existingSessionId || crypto.randomUUID();
    const title = `${sourceTag(session.source)} ${session.threadName || firstUserSnippet(session) || 'Synced chat'}`.slice(0, 200);
    const modelSelection = project.modelSelection || DEFAULT_MODEL_SELECTION;
    if (!threadExists(db, threadId)) {
      const createdAt = iso(session.createdAt);
      appendEvent(db, { aggregateKind: 'thread', streamId: threadId, type: 'thread.created', occurredAt: createdAt, payload: { threadId, projectId: project.id, title, modelSelection, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null, createdAt, updatedAt: createdAt } });
    }
    const existingCount = Number(db.prepare(`SELECT count(*) AS n FROM orchestration_events WHERE stream_id=? AND event_type='thread.message-sent'`).get(threadId)?.n || 0);
    for (const [index, message] of (session.messages || []).entries()) {
      if (index < existingCount || !message.text || !['user', 'assistant'].includes(message.role)) continue;
      const createdAt = iso(message.ts || session.createdAt);
      appendEvent(db, { aggregateKind: 'thread', streamId: threadId, type: 'thread.message-sent', occurredAt: createdAt, payload: { threadId, messageId: crypto.randomUUID(), role: message.role, text: message.text, attachments: [], turnId: null, streaming: false, createdAt, updatedAt: createdAt } });
    }
    db.exec('COMMIT');
    return { sessionId: threadId, filePath: `t3:${threadId}` };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}

function findOrCreateProject(db, cwd, timestamp) {
  const projected = db.prepare(`SELECT project_id AS id,default_model_selection_json AS model FROM projection_projects WHERE workspace_root=? AND deleted_at IS NULL LIMIT 1`).get(cwd);
  if (projected) return { id: projected.id, modelSelection: parseModel(projected.model) };
  const event = db.prepare(`SELECT payload_json AS payload FROM orchestration_events WHERE event_type='project.created' AND json_extract(payload_json,'$.workspaceRoot')=? ORDER BY sequence DESC LIMIT 1`).get(cwd);
  if (event) { const payload = JSON.parse(event.payload); return { id: payload.projectId, modelSelection: payload.defaultModelSelection || DEFAULT_MODEL_SELECTION }; }
  const projectId = crypto.randomUUID();
  const createdAt = iso(timestamp);
  appendEvent(db, { aggregateKind: 'project', streamId: projectId, type: 'project.created', occurredAt: createdAt, payload: { projectId, title: path.basename(cwd) || 'Synced project', workspaceRoot: cwd, defaultModelSelection: DEFAULT_MODEL_SELECTION, faviconPath: null, scripts: [], createdAt, updatedAt: createdAt } });
  return { id: projectId, modelSelection: DEFAULT_MODEL_SELECTION };
}

function appendEvent(db, { aggregateKind, streamId, type, occurredAt, payload }) {
  db.prepare(`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json) VALUES (?,?,?,COALESCE((SELECT max(stream_version)+1 FROM orchestration_events WHERE aggregate_kind=? AND stream_id=?),0),?,?,NULL,NULL,NULL,'server',?,'{}')`).run(crypto.randomUUID(), aggregateKind, streamId, aggregateKind, streamId, type, occurredAt, JSON.stringify(payload));
}
function threadExists(db, threadId) { return !!db.prepare(`SELECT 1 FROM orchestration_events WHERE stream_id=? AND event_type='thread.created' LIMIT 1`).get(threadId); }
function parseModel(value) { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function iso(value) { const d = new Date(value || Date.now()); return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); }
function firstUserSnippet(session) { return session.messages?.find((m) => m.role === 'user')?.text?.replace(/\s+/g, ' ').slice(0, 100); }
function sourceTag(source) { return source === 'claude' ? '[Claude Code]' : source === 'codex' ? '[Codex]' : source === 'cursor' ? '[Cursor]' : `[${source}]`; }
