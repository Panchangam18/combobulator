import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { PATHS } from '../config.js';

const execFileP = promisify(execFile);
async function sqlite(query) {
  if (!fs.existsSync(PATHS.t3Db)) return [];
  // Do not use immutable=1: T3 runs in WAL mode and fresh events may live in
  // the WAL while the app is open.
  const { stdout } = await execFileP('sqlite3', ['-json', `file:${PATHS.t3Db}?mode=ro`, query], { maxBuffer: 256 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : [];
}
export async function listT3Threads() {
  const rows = await sqlite(`SELECT t.thread_id AS id,t.title,t.created_at AS createdAt,t.updated_at AS updatedAt,p.workspace_root AS cwd FROM projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE t.deleted_at IS NULL ORDER BY t.updated_at DESC LIMIT 200;`);
  return rows.map((r) => ({ id:r.id, title:r.title, cwd:r.cwd, createdAt:Date.parse(r.createdAt)||0, updatedAt:Date.parse(r.updatedAt)||0 }));
}
export async function readT3Thread(thread) {
  const id = thread.id.replaceAll("'", "''");
  const rows = await sqlite(`SELECT role,text,created_at AS createdAt FROM projection_thread_messages WHERE thread_id='${id}' ORDER BY created_at,message_id;`);
  const isMirror = /^\[(Claude Code|Codex|Cursor)\]\s/.test(thread.title || '');
  return { source:'t3', sessionId:thread.id, cwd:thread.cwd, threadName:thread.title, createdAt:thread.createdAt||Date.now(), updatedAt:thread.updatedAt||Date.now(), messages:rows.filter((r)=>(r.role==='user'||r.role==='assistant')&&r.text?.trim()).map((r)=>({role:r.role,text:r.text.trim(),ts:Date.parse(r.createdAt)||Date.now()})), isMirror, sourcePath:`t3:${thread.id}` };
}
