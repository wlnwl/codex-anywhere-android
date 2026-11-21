import { createHash } from 'node:crypto';
import { asyncQuestionsFromItem } from '../shared/async-questions.js';
import { isMcpToolApproval } from './app-server-permissions.js';
import { conversationTurns, desktopApprovalId, isDesktopApproval } from './desktop-controls.js';

type State = Record<string, any>;
type Kind = 'completed' | 'failed' | 'approval' | 'input';
export type DesktopTaskNotification = { threadId: string; eventId: string; kind: Kind };
type Target = { clientId: string; channelId: string };
type ThreadWatch = { owner?: string; active: Set<string>; sent: Set<string> };
type ClientWatch = Target & { expires: number; threads: Map<string, ThreadWatch> };

const WATCH_LEASE_MS = 55_000;
const FOLLOW_REFRESH_MS = 10_000;
const MAX_THREADS = 4; // The existing native Desktop follower has four slots.
const MAX_WATCHERS = 32;

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
}

function inputEventId(owner: string, request: State) {
  if (identifier(request.params?.itemId)) return 'input:' + request.params.itemId;
  return 'input:desktop:' + createHash('sha256')
    .update(JSON.stringify([owner, request.id, request.method, request.params?.turnId])).digest('hex');
}

export class DesktopNotifications {
  private readonly clients = new Map<string, ClientWatch>();
  private readonly reads = new Map<string, { started: number; pending: boolean }>();

  constructor(private readonly options: {
    allowed: (threadId: string) => boolean;
    current: (target: Target) => boolean;
    follow: (threadId: string) => Promise<{ state: State; owner: string }>;
    send: (target: Target, notice: DesktopTaskNotification) => void;
    now?: () => number;
  }) {}

  watch(target: Target, payload: State) {
    const requested = payload.threadIds ?? (payload.threadId === undefined ? [] : [payload.threadId]);
    if (!Array.isArray(requested) || requested.length > MAX_THREADS || requested.some(id => !identifier(id))) {
      throw new Error('notification_watch_invalid_threads');
    }
    const now = this.options.now?.() ?? Date.now();
    this.prune(now);
    if (!this.options.current(target)) throw new Error('notification_watch_channel_unavailable');

    const threadIds = [...new Set<string>(requested)].filter(this.options.allowed);
    const old = this.clients.get(target.clientId);
    const total = new Set([...threadIds, ...[...this.clients.values()]
      .filter(client => client.clientId !== target.clientId).flatMap(client => [...client.threads.keys()])]);
    if (total.size > MAX_THREADS || (threadIds.length && !old && this.clients.size >= MAX_WATCHERS)) {
      throw new Error('notification_watch_limit');
    }
    const threads = new Map(threadIds.map(id => [id,
      old?.channelId === target.channelId && old.threads.get(id) || { active: new Set<string>(), sent: new Set<string>() },
    ]));
    if (threads.size) this.clients.set(target.clientId, { ...target, expires: now + WATCH_LEASE_MS, threads });
    else this.clients.delete(target.clientId);
    for (const threadId of threads.keys()) this.follow(threadId, now);
    return { watchedThreadIds: threadIds, leaseMs: WATCH_LEASE_MS };
  }

  observe(threadId: string, state: State, owner: string) {
    if (state.id !== threadId) return;
    this.prune(this.options.now?.() ?? Date.now());
    const viewers = [...this.clients.values()].filter(client => client.threads.has(threadId));
    if (!viewers.length || !this.options.allowed(threadId)) return;

    const active = new Set<string>();
    const turns = new Map<string, State>();
    for (const turn of conversationTurns(state)) {
      if (!identifier(turn?.turnId)) continue;
      turns.set(turn.turnId, turn);
    }
    for (const [id, turn] of turns) if (turn.status === 'inProgress') active.add(id);

    for (const client of viewers) {
      const observer = client.threads.get(threadId)!;
      const baseline = observer.owner !== owner;
      if (baseline) {
        observer.owner = owner;
        observer.active.clear();
      }
      const send = (eventId: string, kind: Kind) => {
        if (observer.sent.has(eventId)) return;
        observer.sent.add(eventId);
        if (observer.sent.size > 256) observer.sent.delete(observer.sent.values().next().value!);
        this.options.send(client, { threadId, eventId, kind });
      };
      for (const id of observer.active) {
        const turn = turns.get(id);
        if (turn?.status === 'failed' || turn?.status === 'error') send('turn:' + id, 'failed');
        else if (turn?.status === 'completed') send('turn:' + id, turn.error ? 'failed' : 'completed');
      }

      for (const request of Array.isArray(state.requests) ? state.requests : []) {
        if (!request || request.id == null) continue;
        if (isDesktopApproval(request) || isMcpToolApproval(request.method, request.params ?? {})) {
          send('approval:' + desktopApprovalId(owner, request), 'approval');
        } else if (request.method === 'item/tool/requestUserInput' || request.method === 'mcpServer/elicitation/request') {
          send(inputEventId(owner, request), 'input');
        }
      }

      // Only running or just-finished turns can introduce a new async question.
      // Record questions that already exist in a newly observed turn silently.
      for (const id of new Set([...active, ...observer.active])) {
        const turn = turns.get(id);
        for (const item of Array.isArray(turn?.items) ? turn.items : []) {
          if (!item || !asyncQuestionsFromItem(item)) continue;
          const eventId = 'input:' + item.id;
          if (!baseline) send(eventId, 'input');
          else if (observer.sent.size < 256) observer.sent.add(eventId);
        }
      }
      observer.active = active;
    }
  }

  invalidate(threadId: string) {
    for (const client of this.clients.values()) {
      const observer = client.threads.get(threadId);
      if (observer) { observer.owner = undefined; observer.active = new Set(); }
    }
  }

  clear() { this.clients.clear(); this.reads.clear(); }

  private prune(now: number) {
    for (const [id, watch] of this.clients) {
      if (watch.expires <= now || !this.options.current(watch)) this.clients.delete(id);
    }
    for (const [id, read] of this.reads) {
      if (!read.pending && read.started + FOLLOW_REFRESH_MS <= now) this.reads.delete(id);
    }
  }

  private follow(threadId: string, now: number) {
    const previous = this.reads.get(threadId);
    if (previous?.pending || (previous && now - previous.started < FOLLOW_REFRESH_MS)) return;
    if (this.reads.size >= MAX_THREADS) return;
    const read = { started: now, pending: true };
    this.reads.set(threadId, read);
    void this.options.follow(threadId).then(({ state, owner }) => {
      if (this.reads.get(threadId) === read) this.observe(threadId, state, owner);
    }).catch(() => { /* a later renewal retries without opening Desktop */ }).finally(() => { read.pending = false; });
  }
}
