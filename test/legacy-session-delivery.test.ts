import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { CodexDesktopClient } from '../src/connector/codex-desktop.js';
import { NativeRequestError } from '../src/connector/desktop-native-pipe.js';
import { ManagedSessions } from '../src/connector/managed-sessions.js';

const id = 'legacy-thread';
const cwd = process.cwd();

function legacyRuntime(options: {
  read?: Record<string, unknown>;
  resumed?: Record<string, unknown>;
  resumeError?: string;
  persistError?: string;
  turnError?: string;
} = {}) {
  const operations: string[] = [];
  const sessions = new ManagedSessions();
  const codex = new CodexAppServer({
    runtimeCwd: cwd, allowedRoots: [cwd], releaseRuntimeAfterTurn: true,
    managedSessions: {
      has: (id) => sessions.has(id),
      add: (id) => {
        operations.push('record-route');
        if (options.persistError) throw new Error(options.persistError);
        sessions.add(id);
      },
    },
  });
  codex.ensureStarted = async () => {};
  codex.rpcRaw = async (method, payload) => {
    operations.push(method);
    assert.equal(payload.threadId, id);
    if (method === 'thread/read') {
      assert.equal(payload.includeTurns, false);
      return { thread: { id, cwd, ...options.read } } as any;
    }
    if (method === 'thread/resume') {
      assert.deepEqual(payload, { threadId: id, cwd, excludeTurns: true });
      if (options.resumeError) throw new Error(options.resumeError);
      return { thread: { id, cwd, status: { type: 'idle' }, ...options.resumed } } as any;
    }
    if (method === 'turn/start') {
      assert.deepEqual(payload, { threadId: id, cwd, input: [{ type: 'text', text: 'One draft' }] });
      assert.equal(sessions.has(id), true, 'durable reroute precedes sending');
      if (options.turnError) throw new Error(options.turnError);
      return { turn: { id: 'new-turn' } } as any;
    }
    assert.equal(method, 'thread/unsubscribe');
    return {} as any;
  };
  const send = (desktopError?: string) => codex.startLegacyTurn({
    threadId: id, text: 'One draft',
    // The first adapted turn must keep the original thread settings.
    permissionMode: 'full', cwd: dirname(cwd),
  }, async () => {
    operations.push('desktop-readiness');
    if (desktopError) throw new Error(desktopError);
  });
  return { codex, operations, send };
}

test('legacy adoption checks the authorized old thread and records ownership before exactly one send', async () => {
  const { codex, send, operations } = legacyRuntime();
  assert.deepEqual(await send(), { threadId: id });
  assert.deepEqual(operations, ['thread/read', 'desktop-readiness', 'thread/resume', 'record-route', 'turn/start']);
  assert.equal(codex.getActiveTurn(id)?.turnId, 'new-turn');
  assert.equal(codex.ownsManagedSession(id), true);
});

test('the selected session and allowed workspace are verified before checking or claiming the writer', async () => {
  const conditions = [
    [{ id: 'different-thread' }, 'legacy_session_state_unavailable'],
    [{ canAcceptDirectInput: false }, 'legacy_session_state_unavailable'],
    [{ cwd: dirname(cwd) }, 'workspace_outside_allowed_root'],
  ] as const;
  for (const [read, message] of conditions) {
    const { codex, operations, send } = legacyRuntime({ read });
    await assert.rejects(send(), { message });
    assert.deepEqual(operations, ['thread/read']);
    assert.equal(codex.ownsManagedSession(id), false);
    assert.equal(codex.activeTurns.size, 0);
  }
});

test('Desktop approval or stale readiness prevents any app-server resume or send', async () => {
  const { codex, operations, send } = legacyRuntime();
  await assert.rejects(send('legacy_session_busy'), { message: 'legacy_session_busy' });
  assert.deepEqual(operations, ['thread/read', 'desktop-readiness']);
  assert.equal(codex.ownsManagedSession(id), false);
});

test('parallel sends cannot claim the same legacy session while Desktop verification is pending', async () => {
  const { codex, operations, send } = legacyRuntime();
  const checkStarted = Promise.withResolvers<void>();
  const allowResume = Promise.withResolvers<void>();
  const first = codex.startLegacyTurn({ threadId: id, text: 'One draft' }, async () => {
    operations.push('desktop-readiness');
    checkStarted.resolve();
    await allowResume.promise;
  });
  await checkStarted.promise;
  try {
    await assert.rejects(send(), /desktop_first_turn_busy|another_turn_is_active/);
    assert.deepEqual(operations, ['thread/read', 'desktop-readiness']);
  } finally {
    allowResume.resolve();
    await first;
  }
  assert.equal(operations.filter(op => op === 'turn/start').length, 1);
});

test('legacy adoption resists writer conflicts, wrong resume IDs and active resumed threads', async () => {
  const conditions = [
    [{ resumeError: 'thread already has an active writer' }, 'thread_active_writer_conflict'],
    [{ resumed: { id: 'different-thread' } }, 'session_delivery_mismatch'],
    [{ resumed: { status: { type: 'active' } } }, 'legacy_session_busy'],
    [{ resumed: { cwd: join(cwd, 'src') } }, 'session_delivery_mismatch'],
  ] as const;
  for (const [options, message] of conditions) {
    const { codex, operations, send } = legacyRuntime(options);
    await assert.rejects(send(), { message });
    assert.deepEqual(operations, ['thread/read', 'desktop-readiness', 'thread/resume', 'thread/unsubscribe']);
    assert.equal(codex.ownsManagedSession(id), false);
    assert.equal(codex.activeTurns.size, 0);
  }
});

test('legacy route persistence failure releases the acquired session without submitting the draft', async () => {
  const { codex, operations, send } = legacyRuntime({ persistError: 'managed_sessions_persist_failed' });
  await assert.rejects(send(), { message: 'managed_sessions_persist_failed' });
  assert.deepEqual(operations, [
    'thread/read', 'desktop-readiness', 'thread/resume', 'record-route', 'thread/unsubscribe',
  ]);
  assert.equal(codex.ownsManagedSession(id), false);
  assert.equal(codex.activeTurns.size, 0);
});

test('an uncertain first app-server send does not replay or remove the acquired route', async () => {
  const { codex, operations, send } = legacyRuntime({ turnError: 'RPC timeout: turn/start' });
  await assert.rejects(send(), { message: 'RPC timeout: turn/start' });
  assert.deepEqual(operations, [
    'thread/read', 'desktop-readiness', 'thread/resume', 'record-route', 'turn/start', 'thread/unsubscribe',
  ]);
  assert.equal(codex.ownsManagedSession(id), true);
  assert.equal(codex.activeTurns.size, 0);
});

test('legacy Desktop readiness binds the exact Codex thread, rejects busy/unknown data and confirms missing native input', async () => {
  const desktop = new CodexDesktopClient();
  let thread: Record<string, unknown> = { id, kind: 'codex', status: { type: 'notLoaded' } };
  let missing = true;
  desktop.callTool = async ({ tool, callerThreadId, arguments: args }) => {
    assert.equal(tool, 'read_thread');
    assert.equal(callerThreadId, id);
    assert.equal(args.threadId, id);
    assert.equal(args.includeOutputs, false);
    return { success: true, structuredContent: { thread } };
  };
  desktop.userInput.pipe.connect = async () => {
    if (missing) throw new NativeRequestError('missing pipe', false, 'desktop_input_pipe_missing');
  };
  try {
    await desktop.assertLegacySessionIdle(id);
    thread = { ...thread, status: { type: 'active', activeFlags: ['waitingOnApproval'] } };
    await assert.rejects(desktop.assertLegacySessionIdle(id), { message: 'legacy_session_busy' });
    thread = { ...thread, status: { type: 'idle', activeFlags: ['waitingOnApproval'] } };
    await assert.rejects(desktop.assertLegacySessionIdle(id), { message: 'legacy_session_busy' });
    thread = { ...thread, status: 'unknown' };
    await assert.rejects(desktop.assertLegacySessionIdle(id), { message: 'legacy_session_state_unavailable' });
    thread = { ...thread, id: 'other-thread', status: 'idle' };
    await assert.rejects(desktop.assertLegacySessionIdle(id), { message: 'legacy_session_state_unavailable' });
    thread = { ...thread, id, kind: 'chatgpt' };
    await assert.rejects(desktop.assertLegacySessionIdle(id), { message: 'legacy_session_state_unavailable' });
    thread = { ...thread, kind: 'codex' };
    missing = false;
    await assert.rejects(desktop.assertLegacySessionIdle(id), { message: 'legacy_session_native_available' });
  } finally {
    desktop.close();
  }
});

test('legacy adoption never treats ambiguous native errors as a missing pipe', async () => {
  const desktop = new CodexDesktopClient();
  try {
    for (const failure of [
      new Error('timed out waiting for Desktop'),
      new NativeRequestError('connection lost', true, 'desktop_input_pipe_missing'),
      new NativeRequestError('connection denied', false),
    ]) {
      desktop.userInput.pipe.connect = async () => { throw failure; };
      assert.equal(await desktop.nativeInputMissing(), false);
    }
  } finally {
    desktop.close();
  }
});
