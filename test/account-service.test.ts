import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountService, type AccountTransport } from '../src/connector/account-service.js';

const snapshot = () => ({
  activeSessionId: 'session-a', accessToken: 'test-secret',
  sessions: [{ sessionId: 'session-a', email: 'person@example.com', displayName: 'Example', isActive: true,
    selectedWorkspaceAccountId: 'workspace-a', refreshToken: 'test-secret',
    workspaces: [{ accountId: 'workspace-a', name: 'Personal', kind: 'personal', privateField: 'test-secret' }] }],
});
const prompt = () => ({ type: 'chatgptDeviceCode', loginId: 'login-a',
  verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234', accessToken: 'test-secret' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function setup(options: { onAccountChanged?: () => void } = {}) {
  let now = 1000;
  let listener: ((method: string, params: any) => void) | null = null;
  const calls: Array<{ method: string; params: any }> = [];
  let handler = async (method: string, _params: any): Promise<any> => (
    method === 'account/login/start' ? prompt() : method === 'account/login/cancel' ? { status: 'canceled' }
      : method === 'account/read' ? { account: null } : snapshot()
  );
  const transport: AccountTransport = {
    request(method, params) { calls.push({ method, params }); return handler(method, params); },
    onNotification(next) { listener = next; return () => { listener = null; }; },
  };
  const service = new AccountService(transport, { now: () => now, ...options });
  return { service, calls, handle(next: typeof handler) { handler = next; },
    advance(ms: number) { now += ms; }, notify(method: string, params: any) { listener?.(method, params); } };
}

test('account listing exposes only the session and workspace display fields', async () => {
  const { service, calls } = setup();
  const result = await service.dispatch('account.sessions.list', {}, 'phone-a');
  assert.equal(result.sessions[0].email, 'person@example.com');
  assert.deepEqual(result.sessions[0].workspaces, [{ accountId: 'workspace-a', name: 'Personal', kind: 'personal' }]);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  assert.deepEqual(calls[0], { method: 'accountSession/list', params: { refreshWorkspaceMetadata: true } });
});

test('workspace metadata refresh defaults on and accepts an explicit cached-only request', async () => {
  const { service, calls } = setup();
  await service.dispatch('account.sessions.list', {}, 'phone-a');
  await service.dispatch('account.sessions.list', { refreshWorkspaceMetadata: false }, 'phone-a');
  assert.deepEqual(calls.filter(call => call.method === 'accountSession/list').map(call => call.params), [
    { refreshWorkspaceMetadata: true }, { refreshWorkspaceMetadata: false },
  ]);
});

test('only the current ChatGPT plan display fields augment the workspace list', async () => {
  const { service, handle, calls } = setup();
  handle(async method => method === 'account/read' ? { account: {
    type: 'chatgpt', planType: 'TEAM', workspaceName: 'Example\nCompany', email: 'not-forwarded@example.com',
    accessToken: 'test-secret', subscriptionPlan: 'test-secret',
  }, workspaceRouting: { chatgptAccountId: 'workspace-a', privateField: 'test-secret' } } : snapshot());
  const result = await service.dispatch('account.sessions.list', {}, 'phone-a');
  assert.deepEqual(result.activeAccount, { planType: 'team', workspaceName: 'ExampleCompany' });
  assert.equal(result.sessions[0].workspaces[0].planType, undefined);
  assert.equal(JSON.stringify(result).includes('not-forwarded@example.com'), false);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  assert.deepEqual(calls.find(call => call.method === 'account/read')?.params, { refreshToken: false });
  handle(async method => method === 'account/read' ? { account: { type: 'chatgpt', planType: 'pro\nsecret', workspaceName: null } } : snapshot());
  assert.deepEqual((await service.dispatch('account.sessions.list', {}, 'phone-a')).activeAccount,
    { planType: null, workspaceName: null });
  handle(async method => method === 'account/read' ? { account: { type: 'apiKey', planType: 'pro' } } : snapshot());
  assert.equal((await service.dispatch('account.sessions.list', {}, 'phone-a')).activeAccount, undefined);
});

test('optional plan lookup failure preserves both a valid list and a successful native switch', async () => {
  let changes = 0;
  const { service, handle } = setup({ onAccountChanged() { changes++; } });
  handle(async method => {
    if (method === 'account/read') throw new Error('private-token');
    return snapshot();
  });
  assert.equal((await service.dispatch('account.sessions.list', {}, 'phone-a')).sessions.length, 1);
  const result = await service.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
  assert.equal(result.activeSessionId, 'session-a');
  assert.equal(changes, 1);
});

test('switch validates a fresh membership snapshot and disables implicit browser login', async () => {
  const { service, calls } = setup();
  await assert.rejects(service.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'other' }, 'phone-a'), /account_selection_not_available/);
  assert.equal(calls.some(call => call.method === 'accountSession/switch'), false);
  await service.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
  assert.deepEqual(calls.findLast(call => call.method === 'accountSession/switch'), { method: 'accountSession/switch', params: {
    sessionId: 'session-a', accountId: 'workspace-a', allowBrowserLogin: false,
  } });
  assert.deepEqual(calls[0].params, { refreshWorkspaceMetadata: true });
});

test('concurrent switches are serialized and raw transport errors are redacted', async () => {
  const { service, handle } = setup();
  const pending = deferred<any>();
  handle(async () => pending.promise);
  const first = service.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
  await assert.rejects(service.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a'), /account_operation_in_progress/);
  pending.resolve({ sessions: [] });
  await assert.rejects(first, /account_selection_not_available/);
  handle(async () => { throw new Error('private-token@example.com test-secret'); });
  await assert.rejects(service.dispatch('account.sessions.list', {}, 'phone-a'), { message: 'account_list_unavailable' });
});

test('repeated and concurrent login starts reuse one prompt and remain bound to the paired device', async () => {
  const { service, handle, calls } = setup();
  const pending = deferred<any>();
  handle(async () => pending.promise);
  const first = service.dispatch('account.login.start', {}, 'phone-a');
  const second = service.dispatch('account.login.start', {}, 'phone-a');
  await assert.rejects(service.dispatch('account.login.start', {}, 'phone-b'), /account_login_owned_by_other_device/);
  await assert.rejects(service.dispatch('account.login.status', {}, 'phone-b'), /account_login_owned_by_other_device/);
  await assert.rejects(service.dispatch('account.login.cancel', {}, 'phone-b'), /account_login_owned_by_other_device/);
  await assert.rejects(service.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a'), /account_operation_in_progress/);
  pending.resolve(prompt());
  const result = await first;
  assert.deepEqual(await second, result);
  assert.equal(result.status, 'pending');
  assert.equal(result.userCode, 'TEST-1234');
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  assert.deepEqual(await service.dispatch('account.login.start', {}, 'phone-a'), result);
  assert.equal(calls.filter(call => call.method === 'account/login/start').length, 1);
});

test('completion notifications redact device prompts and ignore another login', async () => {
  const { service, notify } = setup();
  await service.dispatch('account.login.start', {}, 'phone-a');
  notify('account/login/completed', { loginId: 'other', success: true });
  assert.equal((await service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a')).status, 'pending');
  notify('account/login/completed', { loginId: 'login-a', success: true, token: 'test-secret' });
  const result = await service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a');
  assert.equal(result.status, 'completed');
  assert.equal(result.verificationUrl, undefined);
  assert.equal(result.userCode, undefined);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});

test('an early native completion is retained until its login response arrives', async () => {
  const { service, handle, notify } = setup();
  handle(async () => { notify('account/login/completed', { loginId: 'login-a', success: true }); return prompt(); });
  const result = await service.dispatch('account.login.start', {}, 'phone-a');
  assert.equal(result.status, 'completed');
  assert.equal(result.userCode, undefined);
});

test('cancel during startup also cancels the eventual native login', async () => {
  const { service, handle, calls } = setup();
  const pending = deferred<any>();
  handle(async method => method === 'account/login/start' ? pending.promise : {});
  const first = service.dispatch('account.login.start', {}, 'phone-a');
  assert.equal((await service.dispatch('account.login.cancel', {}, 'phone-a')).status, 'cancelled');
  pending.resolve(prompt());
  const result = await first;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.userCode, undefined);
  assert.equal(calls.filter(call => call.method === 'account/login/cancel').length, 1);
});

test('expiry removes the code while a late native success reports the actual committed account change', async () => {
  let changes = 0;
  const { service, advance, notify, calls } = setup({ onAccountChanged() { changes++; } });
  await service.dispatch('account.login.start', {}, 'phone-a');
  advance(15 * 60_000);
  const result = await service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a');
  assert.equal(result.status, 'failed');
  assert.equal(result.message, 'account_login_expired');
  assert.equal(result.userCode, undefined);
  assert.equal(calls.filter(call => call.method === 'account/login/cancel').length, 1);
  notify('account/login/completed', { loginId: 'login-a', success: true });
  notify('account/login/completed', { loginId: 'login-a', success: true });
  const completed = await service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.userCode, undefined);
  assert.equal(changes, 1);
  await new Promise<void>(resolve => setImmediate(resolve));
  advance(10 * 60_000);
  assert.deepEqual(await service.dispatch('account.login.status', {}, 'phone-a'), { status: 'idle' });
});

test('untrusted login URL is rejected and its native attempt cancelled', async () => {
  const { service, handle, calls } = setup();
  handle(async method => method === 'account/login/start' ? { ...prompt(), verificationUrl: 'https://untrusted.example/device' } : {});
  await assert.rejects(service.dispatch('account.login.start', {}, 'phone-a'), { message: 'account_login_response_invalid' });
  assert.equal(calls.filter(call => call.method === 'account/login/cancel').length, 1);
});

test('an old screen cannot read or cancel a replacement login attempt', async () => {
  const { service, handle, notify, calls } = setup();
  await service.dispatch('account.login.start', {}, 'phone-a');
  notify('account/login/completed', { loginId: 'login-a', success: true });
  handle(async method => method === 'account/login/start' ? { ...prompt(), loginId: 'login-b' } : {});
  await service.dispatch('account.login.start', {}, 'phone-a');
  await assert.rejects(service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a'), /account_login_stale/);
  await assert.rejects(service.dispatch('account.login.cancel', { loginId: 'login-a' }, 'phone-a'), /account_login_stale/);
  await assert.rejects(service.dispatch('account.login.cancel', {}, 'phone-a'), /account_login_stale/);
  const current = await service.dispatch('account.login.status', { loginId: 'login-b' }, 'phone-a');
  assert.equal(current.status, 'pending');
  assert.equal(calls.some(call => call.method === 'account/login/cancel'), false);
});

test('closing service cancels pending login and removes notification listener', async () => {
  const { service, notify, calls } = setup();
  await service.dispatch('account.login.start', {}, 'phone-a');
  service.close();
  notify('account/login/completed', { loginId: 'login-a', success: true });
  assert.equal(calls.filter(call => call.method === 'account/login/cancel').length, 1);
  await assert.rejects(service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a'), /account_service_closed/);
});

test('closing while membership is loading prevents a later native switch', async () => {
  const { service, handle, calls } = setup();
  const membership = deferred<any>();
  handle(async () => membership.promise);
  const switching = service.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
  service.close();
  membership.resolve(snapshot());
  await assert.rejects(switching, /account_service_closed/);
  assert.equal(calls.some(call => call.method === 'accountSession/switch'), false);
});

test('a native switch must confirm the requested active session and workspace', async () => {
  let changes = 0;
  const { service, handle } = setup({ onAccountChanged() { changes++; } });
  handle(async method => method === 'accountSession/list' ? snapshot() : {
    ...snapshot(), activeSessionId: 'different-session',
  });
  await assert.rejects(service.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a'), /account_switch_not_confirmed/);
  handle(async method => {
    const response = snapshot();
    if (method === 'accountSession/switch') response.sessions[0].selectedWorkspaceAccountId = 'different-workspace';
    return response;
  });
  await assert.rejects(service.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a'), /account_switch_not_confirmed/);
  assert.equal(changes, 0);
});

test('successful auth stays successful when the change callback throws or rejects', async () => {
  const switched = setup({ onAccountChanged() { throw new Error('ui failed'); } });
  const result = await switched.service.dispatch('account.sessions.switch', { sessionId: 'session-a', accountId: 'workspace-a' }, 'phone-a');
  assert.equal(result.activeSessionId, 'session-a');
  const loggedIn = setup({ onAccountChanged: async () => { throw new Error('ui failed asynchronously'); } });
  await loggedIn.service.dispatch('account.login.start', {}, 'phone-a');
  loggedIn.notify('account/login/completed', { loginId: 'login-a', success: true });
  assert.equal((await loggedIn.service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a')).status, 'completed');
});

test('notFound cancellation stays pending until the native completion arrives', async () => {
  let changes = 0;
  const { service, handle, notify } = setup({ onAccountChanged() { changes++; } });
  await service.dispatch('account.login.start', {}, 'phone-a');
  handle(async () => ({ status: 'notFound' }));
  await assert.rejects(service.dispatch('account.login.cancel', { loginId: 'login-a' }, 'phone-a'), /account_login_cancel_unconfirmed/);
  assert.equal((await service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a')).status, 'pending');
  notify('account/login/completed', { loginId: 'login-a', success: true });
  const completed = await service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.userCode, undefined);
  assert.equal(changes, 1);
});

test('a completion during cancellation remains authoritative and blocks a replacement until cancellation finishes', async () => {
  const { service, handle, notify } = setup();
  await service.dispatch('account.login.start', {}, 'phone-a');
  const cancellation = deferred<any>();
  handle(async () => cancellation.promise);
  const cancelling = service.dispatch('account.login.cancel', { loginId: 'login-a' }, 'phone-a');
  notify('account/login/completed', { loginId: 'login-a', success: true });
  await assert.rejects(service.dispatch('account.login.start', {}, 'phone-a'), /account_operation_in_progress/);
  cancellation.resolve({ status: 'notFound' });
  assert.equal((await cancelling).status, 'completed');
});

test('native completion after a confirmed cancellation still reports the committed account', async () => {
  let changes = 0;
  const { service, notify } = setup({ onAccountChanged() { changes++; } });
  await service.dispatch('account.login.start', {}, 'phone-a');
  assert.equal((await service.dispatch('account.login.cancel', { loginId: 'login-a' }, 'phone-a')).status, 'cancelled');
  notify('account/login/completed', { loginId: 'login-a', success: true });
  const result = await service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a');
  assert.equal(result.status, 'completed');
  assert.equal(result.userCode, undefined);
  assert.equal(changes, 1);
});

test('login closes safely before the native start response arrives', async () => {
  const { service, handle, calls } = setup();
  const pending = deferred<any>();
  handle(async method => method === 'account/login/start' ? pending.promise : { status: 'canceled' });
  const starting = service.dispatch('account.login.start', {}, 'phone-a');
  service.close();
  pending.resolve(prompt());
  const result = await starting;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.userCode, undefined);
  assert.equal(calls.filter(call => call.method === 'account/login/cancel').length, 1);
});

test('a committed early completion is not lost when the service closes before the start response', async () => {
  let changes = 0;
  const { service, handle, notify } = setup({ onAccountChanged() { changes++; } });
  const pending = deferred<any>();
  handle(async () => pending.promise);
  const starting = service.dispatch('account.login.start', {}, 'phone-a');
  notify('account/login/completed', { loginId: 'login-a', success: true });
  service.close();
  pending.resolve(prompt());
  const result = await starting;
  assert.equal(result.status, 'completed');
  assert.equal(result.userCode, undefined);
  assert.equal(changes, 1);
});

test('pending login expiry runs without another client request', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { service, advance, calls } = setup();
  await service.dispatch('account.login.start', {}, 'phone-a');
  advance(15 * 60_000);
  context.mock.timers.tick(15 * 60_000);
  assert.equal(calls.filter(call => call.method === 'account/login/cancel').length, 1);
  const result = await service.dispatch('account.login.status', { loginId: 'login-a' }, 'phone-a');
  assert.equal(result.status, 'failed');
  assert.equal(result.userCode, undefined);
  service.close();
});
