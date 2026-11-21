import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopNotifications, type DesktopTaskNotification } from '../src/connector/desktop-notifications.js';
import { DesktopInputPipe } from '../src/connector/desktop-input-pipe.js';
import { DesktopState } from '../src/connector/desktop-state.js';
import { desktopApprovalId } from '../src/connector/desktop-controls.js';

const phone = { clientId: 'phone', channelId: 'first' };
const browser = { clientId: 'browser', channelId: 'other' };
const approval = { id: 'request-1', method: 'item/commandExecution/requestApproval', params: { command: 'private' } };
const input = { id: 'request-2', method: 'item/tool/requestUserInput', params: { itemId: 'interactive', question: 'private' } };
const question = { id: 'question-1', type: 'agentMessage', delivery: 'async', questions: [{ title: 'private', options: ['private'] }] };
const done = (id: string, status = 'completed') => ({ turnId: id, status, items: [] });

test('Desktop follower emits only new scoped operational notices; text changes do not scan history', async t => {
  const initial = { id: 'work', turns: [done('old'), done('active', 'inProgress')], requests: [] };
  const pipe = new DesktopInputPipe();
  pipe.follow = async () => {};
  const state = new DesktopState(pipe);
  t.after(() => { state.close(); pipe.close(); });
  const sent: DesktopTaskNotification[] = [];
  const notifications = new DesktopNotifications({
    allowed: id => id === 'work', current: target => target.clientId === phone.clientId,
    follow: async id => ({ state: await state.read(id, 'native', 500), owner: 'native' }),
    send: (_target, event) => sent.push(event),
  });
  let observed = 0;
  state.on('notification-state', (id, value, owner) => { observed++; notifications.observe(id, value, owner); });
  notifications.watch(phone, { threadId: 'work' });
  const change = (revision: number, patch?: Record<string, unknown>, conversationState = initial) => pipe.emit('broadcast', {
    sourceClientId: 'native', method: 'thread-stream-state-changed', version: 11,
    params: { hostId: 'local', conversationId: 'work', change: patch
      ? { type: 'patches', revision, baseRevision: revision - 1, patches: [patch] }
      : { type: 'snapshot', revision, conversationState } },
  });
  change(0);
  assert.equal(sent.length, 0);
  change(1, { op: 'add', path: ['turns', 1, 'items', 0], value: question });
  change(2, { op: 'add', path: ['turns', 1, 'items', 0, 'text'], value: 'private' });
  assert.equal(observed, 2);
  change(3, { op: 'replace', path: ['requests'], value: [approval, input] });
  change(4, { op: 'replace', path: ['turns', 1, 'status'], value: 'completed' });
  // Another valid observation cannot repeat the same IDs.
  change(5, { op: 'replace', path: ['requests'], value: [approval, input] });
  assert.deepEqual(sent, [
    { threadId: 'work', eventId: 'input:question-1', kind: 'input' },
    { threadId: 'work', eventId: 'approval:' + desktopApprovalId('native', approval), kind: 'approval' },
    { threadId: 'work', eventId: 'input:interactive', kind: 'input' },
    { threadId: 'work', eventId: 'turn:active', kind: 'completed' },
  ]);
});

test('Desktop notification leases enforce workspace, explicit scope, channel replacement, and expiry', () => {
  let now = 0;
  let currentChannel = phone.channelId;
  const follows: string[] = [];
  const sent: [string, string, string][] = [];
  const notifications = new DesktopNotifications({
    allowed: id => id !== 'outside', now: () => now,
    current: ({ clientId, channelId }) => clientId === 'phone' ? channelId === currentChannel : channelId === browser.channelId,
    follow: async (id) => { follows.push(id); throw new Error('no Desktop owner yet'); },
    send: ({ clientId }, notice) => sent.push([clientId, notice.eventId, notice.kind]),
  });
  assert.deepEqual(notifications.watch(phone, { threadIds: ['first', 'outside'] }).watchedThreadIds, ['first']);
  notifications.watch(browser, { threadId: 'second' });
  notifications.watch(phone, { threadId: 'first' });
  assert.deepEqual(follows, ['first', 'second']);
  const observe = (threadId: string, turnId: string, status: string) => notifications.observe(threadId, {
    id: threadId, turns: [done(turnId, status)],
  }, 'native');
  for (const id of ['first', 'second', 'outside', 'unwatched']) {
    observe(id, id, 'inProgress');
    observe(id, id, 'failed');
  }
  assert.deepEqual(sent, [['phone', 'turn:first', 'failed'], ['browser', 'turn:second', 'failed']]);

  observe('first', 'cancelled', 'inProgress');
  observe('first', 'cancelled', 'interrupted');
  observe('first', 'lost', 'inProgress');
  notifications.invalidate('first');
  observe('first', 'lost', 'failed');
  observe('first', 'replacement', 'inProgress');
  currentChannel = 'new';
  observe('first', 'replacement', 'completed');
  assert.throws(() => notifications.watch(phone, { threadId: 'first' }), /notification_watch_channel_unavailable/);
  notifications.watch({ ...phone, channelId: 'new' }, { threadId: 'first' });
  observe('first', 'uncertain', 'inProgress');
  notifications.watch({ ...phone, channelId: 'new' }, { threadIds: [] });
  observe('first', 'uncertain', 'completed');
  observe('second', 'expired', 'inProgress');
  now += 55_000;
  observe('second', 'expired', 'failed');
  assert.equal(sent.length, 2);
});
