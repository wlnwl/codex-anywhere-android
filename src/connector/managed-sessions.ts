import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { normalizeAuthDeviceId } from '../shared/auth.js';

const VERSION = 1;
const MAX_SESSIONS = 4_096;
const MAX_ID_LENGTH = 200;
const MAX_BYTES = MAX_SESSIONS * (MAX_ID_LENGTH + 3) + 128;

export function connectorManagedSessionsPath(
  deviceId: string, environment: NodeJS.ProcessEnv = process.env,
) {
  const configured = String(environment.BRIDGE_MANAGED_SESSIONS_FILE || '').trim();
  if (configured) return resolve(configured);
  const key = createHash('sha256').update(normalizeAuthDeviceId(deviceId)).digest('hex');
  return join(homedir(), '.codex-anywhere', `connector-managed-sessions-${key}.json`);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH
    && /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._:-]/.test(value);
}

function load(path: string | null): Set<string> {
  if (!path) return new Set();
  try {
    if (!lstatSync(path).isFile()) return new Set();
    const file = openSync(path, 'r');
    try {
      const info = fstatSync(file);
      if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) return new Set();
      const buffer = Buffer.alloc(info.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = readSync(file, buffer, size, buffer.length - size, null);
        if (read === 0) break;
        size += read;
      }
      if (size !== info.size) return new Set();
      const document = JSON.parse(buffer.toString('utf8', 0, size));
      if (document?.version !== VERSION || !Array.isArray(document.sessions)
        || document.sessions.length > MAX_SESSIONS || !document.sessions.every(validId)) return new Set();
      const ids = new Set<string>(document.sessions);
      return ids.size === document.sessions.length ? ids : new Set();
    } finally {
      closeSync(file);
    }
  } catch {
    return new Set();
  }
}

export class ManagedSessions {
  private readonly path: string | null;
  private readonly ids: Set<string>;

  constructor(path?: string | null) {
    this.path = path ? resolve(path) : null;
    this.ids = load(this.path);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (!validId(id)) throw new Error('managed_session_id_invalid');
    if (this.ids.has(id)) return;
    // Do not silently drop ownership of older sessions when the registry fills up.
    if (this.ids.size >= MAX_SESSIONS) throw new Error('managed_sessions_limit_reached');
    if (this.path) {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      let created = false;
      try {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const file = openSync(temporary, 'wx', 0o600);
        created = true;
        try {
          const data = JSON.stringify({ version: VERSION, sessions: [...this.ids, id] });
          writeFileSync(file, `${data}\n`, { encoding: 'utf8', flush: true });
        } finally {
          closeSync(file);
        }
        renameSync(temporary, this.path);
      } catch {
        if (created) {
          try { rmSync(temporary, { force: true }); } catch { /* Keep the original error. */ }
        }
        throw new Error('managed_sessions_persist_failed');
      }
    }
    this.ids.add(id);
  }
}
