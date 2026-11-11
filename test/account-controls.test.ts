import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountControls } from '../src/connector/account-controls.js';
import type { DesktopRestartStatus } from '../src/connector/desktop-restart.js';

function setup(overrides: { desktop?: boolean; stateFile?: string; busy?: boolean; supported?: boolean;
  restartError?: boolean; restartWait?: Promise<void>; recoveredRestart?: DesktopRestartStatus } = {}) {
  let notify: (method: string, params: any) => void = () => {};
  let restarts = 0;
  let changed = 0;
  let restartState: DesktopRestartStatus | null = null;
  const calls: string[] = [];
  const controls = new AccountControls({
    async request(method) {
      calls.push(method);
      if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'login-a',
        verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234' };
      if (method === 'account/login/cancel') return { status: 'canceled' };
      return { activeSessionId: 'session-a', sessions: [{ sessionId: 'session-a', isActive: true,
        selectedWorkspaceAccountId: 'workspace-a', workspaces: [{ accountId: 'workspace-a', name: 'Personal' }] }] };
    },
    onNotification(listener) { notify = listener; return () => { notify = () => {}; }; },
  }, {
    desktop: overrides.desktop !== false,
    stateFile: overrides.stateFile,
    isBusy: () => overrides.busy === true,
    onAccountChanged: () => { changed++; },
    restarter: {
      isSupported: async () => overrides.supported !== false,
      restart: async () => {
        restarts++;
        await overrides.restartWait;
        if (overrides.restartError) throw new Error('private local path');
        restartState = overrides.recoveredRestart || { id: 'restart-a', status: 'pending', startedAt: Date.now() };
        return { ...restartState };
      },
      status: async id => restartState?.id === id ? { ...restartState } : null,
    },
  });
  return { controls, calls, notify: (method: string, params: any) => notify(method, params),
    restarts: () => restarts, changed: () => changed,
    setRestart(value: DesktopRestartStatus | null) { restartState = value; } };
}

test('native selection persists only a restart reminder and restart requires explicit confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-accounts-'));
  const stateFile = join(directory, 'restart.json');
  const instance = setup({ stateFile });
  try {
    const initial = await instance.controls.dispatch('account.sessions.list', {}, 'phone-a');
    assert.equal(initial.desktopRestartRequired, false);
    const result = await instance.controls.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
    assert.equal(result.desktopRestartRequired, true);
    assert.equal(instance.changed(), 1);
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(saved.restartRequired, true);
    assert.equal(saved.restartRequested, false);
    assert.match(saved.authRevision, /^[0-9a-f-]{36}$/);
    assert.equal(saved.restartId, null);
    const restored = setup({ stateFile });
    assert.equal((await restored.controls.dispatch('account.sessions.list', {}, 'phone-a')).desktopRestartRequired, true);
    restored.controls.close();
    for (const confirm of [undefined, false, 'true', 1]) {
      await assert.rejects(instance.controls.dispatch('account.desktop.restart', { confirm }, 'phone-a'), /confirmation_required/);
    }
    assert.equal(instance.restarts(), 0);
    const restart = await instance.controls.dispatch('account.desktop.restart', { confirm: true }, 'phone-a');
    assert.equal(instance.restarts(), 1);
    assert.equal(restart.desktopRestartRequested, true);
    assert.equal(restart.desktopRestartRequired, true);
    assert.equal(restart.restart.id, 'restart-a');
    assert.equal(restart.restart.status, 'pending');
    assert.equal((await instance.controls.dispatch('account.sessions.list', {}, 'phone-a')).desktopRestartRequested, true);
    instance.setRestart({ id: 'restart-a', status: 'completed' });
    const completed = await instance.controls.dispatch('account.desktop.restart.status', { restartId: 'restart-a' }, 'phone-a');
    assert.equal(completed.desktopRestartRequired, false);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).restartRequired, false);
    assert.deepEqual(readdirSync(directory), ['restart.json']);
  } finally { instance.controls.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a new OAuth completion during restart submission retains its own unverified activation reminder', async () => {
  let finish!: () => void;
  const instance = setup({ restartWait: new Promise<void>(resolve => { finish = resolve; }) });
  try {
    await instance.controls.dispatch('account.login.start', {}, 'phone-a');
    const restarting = instance.controls.dispatch('account.desktop.restart', { confirm: true }, 'phone-a');
    await assert.rejects(instance.controls.dispatch('account.sessions.switch', {}, 'phone-a'), /account_operation_in_progress/);
    await assert.rejects(instance.controls.dispatch('account.login.start', {}, 'phone-a'), /account_operation_in_progress/);
    instance.notify('account/login/completed', { loginId: 'login-a', success: true });
    finish();
    const result = await restarting;
    assert.equal(result.desktopRestartRequired, true);
    assert.equal(result.desktopRestartRequested, false);
    assert.equal(instance.changed(), 1);
    instance.setRestart({ id: 'restart-a', status: 'completed' });
    const oldRestart = await instance.controls.dispatch('account.desktop.restart.status', { restartId: 'restart-a' }, 'phone-a');
    assert.equal(oldRestart.restart.status, 'completed');
    assert.equal(oldRestart.desktopRestartRequired, true);
    assert.equal(oldRestart.desktopRestartRequested, false);
  } finally { finish(); instance.controls.close(); }
});

test('OAuth completion records the reminder even when the phone has not polled', async () => {
  const instance = setup();
  try {
    await instance.controls.dispatch('account.login.start', {}, 'phone-a');
    instance.notify('account/login/completed', { loginId: 'login-a', success: true });
    assert.equal(instance.changed(), 1);
    assert.equal((await instance.controls.dispatch('account.sessions.list', {}, 'phone-a')).desktopRestartRequired, true);
    const completed = await instance.controls.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.userCode, undefined);
    assert.equal(completed.desktopRestartRequired, true);
  } finally { instance.controls.close(); }
});

test('running connector tasks prevent mutations and restart without blocking read-only listing', async () => {
  const instance = setup({ busy: true });
  try {
    for (const action of ['account.sessions.switch', 'account.login.start', 'account.desktop.restart']) {
      await assert.rejects(instance.controls.dispatch(action, { confirm: true }, 'phone-a'), /account_active_turn/);
    }
    assert.deepEqual(instance.calls, []);
    assert.equal(instance.restarts(), 0);
    assert.equal((await instance.controls.dispatch('account.sessions.list', {}, 'phone-a')).sessions.length, 1);
  } finally { instance.controls.close(); }
});

test('headless login requires no Desktop restart; restart failure reveals no native error', async () => {
  const headless = setup({ desktop: false });
  const failed = setup({ restartError: true });
  try {
    await headless.controls.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
    assert.equal((await headless.controls.dispatch('account.sessions.list', {}, 'phone-a')).desktopRestartRequired, false);
    await assert.rejects(headless.controls.dispatch('account.desktop.restart', { confirm: true }, 'phone-a'), /account_desktop_restart_unavailable/);
    await failed.controls.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
    await assert.rejects(failed.controls.dispatch('account.desktop.restart', { confirm: true }, 'phone-a'), { message: 'account_desktop_restart_failed' });
    assert.equal((await failed.controls.dispatch('account.sessions.list', {}, 'phone-a')).desktopRestartRequired, true);
  } finally { headless.controls.close(); failed.controls.close(); }
});

test('a pending helper is reused and blocks further account mutations until its actual result', async () => {
  const instance = setup();
  try {
    await instance.controls.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
    const first = await instance.controls.dispatch('account.desktop.restart', { confirm: true }, 'phone-a');
    const repeated = await instance.controls.dispatch('account.desktop.restart', { confirm: true }, 'phone-a');
    assert.equal(instance.restarts(), 1);
    assert.deepEqual(repeated.restart, first.restart);
    await assert.rejects(instance.controls.dispatch('account.sessions.switch', {}, 'phone-a'), /account_operation_in_progress/);
    await assert.rejects(instance.controls.dispatch('account.login.start', {}, 'phone-a'), /account_operation_in_progress/);
    instance.setRestart({ id: 'restart-a', status: 'failed', error: 'desktop_restart_failed' });
    const failed = await instance.controls.dispatch('account.desktop.restart.status', { restartId: 'restart-a' }, 'phone-a');
    assert.equal(failed.desktopRestartRequired, true);
    assert.equal(failed.desktopRestartRequested, false);
    await instance.controls.dispatch('account.desktop.restart', { confirm: true }, 'phone-a');
    assert.equal(instance.restarts(), 2);
  } finally { instance.controls.close(); }
});

test('restart status is correlated and a missing result never confirms activation', async () => {
  const instance = setup();
  try {
    await instance.controls.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
    await instance.controls.dispatch('account.desktop.restart', { confirm: true }, 'phone-a');
    await assert.rejects(instance.controls.dispatch('account.desktop.restart.status', { restartId: 'stale-id' }, 'phone-a'), /account_desktop_restart_stale/);
    instance.setRestart(null);
    const unknown = await instance.controls.dispatch('account.desktop.restart.status', {}, 'phone-a');
    assert.equal(unknown.restart.status, 'unknown');
    assert.equal(unknown.desktopRestartRequired, true);
    assert.equal(unknown.desktopRestartRequested, false);
  } finally { instance.controls.close(); }
});

test('a restored controller reconciles its durable operation against the verified helper result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-accounts-restored-'));
  const stateFile = join(directory, 'restart.json');
  const first = setup({ stateFile });
  try {
    await first.controls.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
    await first.controls.dispatch('account.desktop.restart', { confirm: true }, 'phone-a');
    first.controls.close();
    const restored = setup({ stateFile });
    try {
      restored.setRestart({ id: 'restart-a', status: 'completed' });
      const result = await restored.controls.dispatch('account.sessions.list', {}, 'phone-a');
      assert.equal(result.restart.status, 'completed');
      assert.equal(result.desktopRestartRequired, false);
    } finally { restored.controls.close(); }
  } finally { first.controls.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('legacy reminders retain the unapplied account without fabricating a correlated operation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-accounts-legacy-'));
  const stateFile = join(directory, 'restart.json');
  writeFileSync(stateFile, JSON.stringify({ version: 1, restartRequired: true, restartRequested: true }));
  const instance = setup({ stateFile });
  try {
    const result = await instance.controls.dispatch('account.sessions.list', {}, 'phone-a');
    assert.equal(result.desktopRestartRequired, true);
    assert.equal(result.desktopRestartRequested, false);
    assert.equal(result.restart, null);
  } finally { instance.controls.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('recovering an untracked helper never attributes its earlier restart to the current account', async () => {
  const instance = setup({ recoveredRestart: { id: 'recovered-a', status: 'pending', startedAt: Date.now() - 10_000 } });
  try {
    await instance.controls.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
    const pending = await instance.controls.dispatch('account.desktop.restart', { confirm: true }, 'phone-a');
    assert.equal(pending.desktopRestartRequired, true);
    assert.equal(pending.desktopRestartRequested, false);
    instance.setRestart({ id: 'recovered-a', status: 'completed' });
    const completed = await instance.controls.dispatch('account.desktop.restart.status', { restartId: 'recovered-a' }, 'phone-a');
    assert.equal(completed.desktopRestartRequired, true);
  } finally { instance.controls.close(); }
});

test('failed reminder replacement preserves native success and cleans its temporary file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-accounts-write-failure-'));
  const stateFile = join(directory, 'restart.json');
  mkdirSync(stateFile);
  const instance = setup({ stateFile });
  try {
    const result = await instance.controls.dispatch('account.sessions.switch', {
      sessionId: 'session-a', accountId: 'workspace-a',
    }, 'phone-a');
    assert.equal(result.desktopRestartRequired, true);
    assert.equal(instance.changed(), 1);
    assert.deepEqual(readdirSync(directory), ['restart.json']);
  } finally { instance.controls.close(); rmSync(directory, { recursive: true, force: true }); }
});
