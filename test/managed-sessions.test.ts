import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ManagedSessions, connectorManagedSessionsPath } from '../src/connector/managed-sessions.js';

test('managed session provenance persists only explicitly recorded session IDs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-managed-sessions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const registry = new ManagedSessions(file);
  registry.add('connector-thread-1');
  registry.add('connector-thread-1');
  registry.add('connector-thread-2');
  const restarted = new ManagedSessions(file);
  assert.equal(restarted.has('connector-thread-1'), true);
  assert.equal(restarted.has('connector-thread-2'), true);
  assert.equal(restarted.has('existing-desktop-thread'), false);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    version: 1, sessions: ['connector-thread-1', 'connector-thread-2'],
  });
  assert.deepEqual(await readdir(directory), ['state.json']);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0);
  assert.notEqual(connectorManagedSessionsPath('device/a', {}), connectorManagedSessionsPath('device-a', {}));
  assert.equal(connectorManagedSessionsPath('test', { BRIDGE_MANAGED_SESSIONS_FILE: file }), file);
});

test('invalid provenance and persistence failures never claim a session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-managed-sessions-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  await writeFile(file, JSON.stringify({ version: 1, sessions: ['untrusted-desktop-thread', {}] }));
  const damaged = new ManagedSessions(file);
  assert.equal(damaged.has('untrusted-desktop-thread'), false);
  assert.throws(() => damaged.add('../bad-id'), /managed_session_id_invalid/);
  assert.throws(() => damaged.add('bad-id\n'), /managed_session_id_invalid/);

  const blocked = join(directory, 'cannot-replace-directory');
  await mkdir(blocked);
  const registry = new ManagedSessions(blocked);
  assert.throws(() => registry.add('connector-thread'), /managed_sessions_persist_failed/);
  assert.equal(registry.has('connector-thread'), false);
  assert.deepEqual((await readdir(directory)).sort(), ['cannot-replace-directory', 'state.json']);
});

test('a full registry keeps existing ownership without silently forgetting sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-managed-sessions-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const sessions = Array.from({ length: 4096 }, (_, index) => `session-${index}`);
  await writeFile(file, JSON.stringify({ version: 1, sessions }));
  const registry = new ManagedSessions(file);
  registry.add(sessions[0]);
  assert.throws(() => registry.add('extra-session'), /managed_sessions_limit_reached/);
  assert.equal(registry.has(sessions[0]), true);
  assert.equal(new ManagedSessions(file).has(sessions.at(-1)!), true);
});
