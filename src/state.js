import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from './config.js';

// Persistent state file shape:
// {
//   epoch: number,         // unix ms; sessions older than this are "pre-existing" and ignored
//   mirrors: {
//     "<source>/<sessionId>": {
//        sourceFingerprint: "<hash of msg count + last ts>",
//        targets: {
//          claude?: { sessionId, filePath },
//          codex?: { sessionId, filePath }
//        }
//     }
//   }
// }

let cache = null;

function emptyState() {
  return { epoch: Date.now(), mirrors: {} };
}

export function loadState() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(PATHS.combobulateState, 'utf8');
    cache = JSON.parse(raw);
    if (!cache.mirrors) cache.mirrors = {};
    if (!cache.epoch) cache.epoch = Date.now();
  } catch {
    cache = emptyState();
  }
  return cache;
}

export function saveState() {
  if (!cache) return;
  fs.mkdirSync(PATHS.combobulateDir, { recursive: true });
  const tmp = PATHS.combobulateState + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, PATHS.combobulateState);
}

export function resetEpoch() {
  loadState();
  cache.epoch = Date.now();
  saveState();
}

export function getMirror(sourceKey) {
  loadState();
  return cache.mirrors[sourceKey];
}

export function setMirror(sourceKey, value) {
  loadState();
  cache.mirrors[sourceKey] = value;
  saveState();
}

export function fingerprintMessages(messages) {
  const h = crypto.createHash('sha1');
  for (const m of messages) {
    h.update(`${m.role}|${m.ts || 0}|${(m.text || '').slice(0, 256)}\n`);
  }
  return `${messages.length}:${h.digest('hex').slice(0, 16)}`;
}
