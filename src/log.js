import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';

let stream = null;

function ensureStream() {
  if (stream) return stream;
  fs.mkdirSync(PATHS.combobulateDir, { recursive: true });
  stream = fs.createWriteStream(PATHS.combobulateLog, { flags: 'a' });
  return stream;
}

function ts() {
  return new Date().toISOString();
}

export function log(level, ...args) {
  const line = `[${ts()}] ${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  process.stdout.write(line);
  try { ensureStream().write(line); } catch {}
}

export const info = (...a) => log('INFO', ...a);
export const warn = (...a) => log('WARN', ...a);
export const error = (...a) => log('ERROR', ...a);
export const debug = (...a) => {
  if (process.env.COMBOBULATE_DEBUG) log('DEBUG', ...a);
};
