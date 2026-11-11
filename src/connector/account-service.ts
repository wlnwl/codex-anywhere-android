type JsonObject = Record<string, any>;

export type AccountTransport = {
  request(method: string, params: JsonObject): Promise<any>;
  onNotification(listener: (method: string, params: JsonObject) => void): () => void;
};

type LoginStatus = 'pending' | 'completed' | 'failed' | 'cancelled';
type LoginAttempt = {
  owner: string;
  loginId: string;
  status: LoginStatus;
  expiresAt: number;
  retainUntil: number;
  verificationUrl?: string;
  userCode?: string;
  message?: string;
  changeNotified?: boolean;
};

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const RESULT_RETENTION_MS = 10 * 60_000;

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('account_invalid_identifier');
  }
  return value;
}

function optionalText(value: unknown, limit = 256): string | null {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : null;
}

// Never forward native auth objects wholesale: future versions may add credentials.
function sessionSnapshot(value: any) {
  if (!Array.isArray(value?.sessions) || value.sessions.length > 100) {
    throw new Error('account_response_invalid');
  }
  return {
    activeSessionId: value.activeSessionId == null ? null : identifier(value.activeSessionId),
    sessions: value.sessions.map((session: any) => ({
      sessionId: identifier(session?.sessionId),
      email: optionalText(session?.email),
      displayName: optionalText(session?.displayName),
      isActive: session?.isActive === true,
      selectedWorkspaceAccountId: session?.selectedWorkspaceAccountId == null
        ? null : identifier(session.selectedWorkspaceAccountId),
      workspaces: Array.isArray(session?.workspaces) ? session.workspaces.slice(0, 100).map((workspace: any) => ({
        accountId: identifier(workspace?.accountId),
        name: optionalText(workspace?.name),
        kind: optionalText(workspace?.kind, 64),
      })) : [],
    })),
  };
}

function devicePrompt(value: any) {
  if (value?.type !== 'chatgptDeviceCode') throw new Error('account_login_unsupported');
  const loginId = identifier(value.loginId);
  let url: URL;
  try { url = new URL(value.verificationUrl); } catch { throw new Error('account_login_response_invalid'); }
  if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password
    || url.port && url.port !== '443' || url.hash) throw new Error('account_login_response_invalid');
  if (typeof value.userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(value.userCode)) {
    throw new Error('account_login_response_invalid');
  }
  return { loginId, verificationUrl: url.href, userCode: value.userCode };
}

export class AccountService {
  private readonly now: () => number;
  private readonly unsubscribe: () => void;
  private readonly onAccountChanged?: () => void;
  private login: LoginAttempt | null = null;
  private mutating = false;
  private loginStart: Promise<any> | null = null;
  private loginCancel: Promise<any> | null = null;
  private loginExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private earlyCompletions = new Map<string, boolean>();

  constructor(private readonly transport: AccountTransport, options: {
    now?: () => number;
    onAccountChanged?: () => void;
  } = {}) {
    this.now = options.now || Date.now;
    this.onAccountChanged = options.onAccountChanged;
    this.unsubscribe = transport.onNotification((method, params) => this.notification(method, params));
  }

  async dispatch(action: string, payload: JsonObject, clientDeviceId: string): Promise<any> {
    if (this.closed) throw new Error('account_service_closed');
    const owner = identifier(clientDeviceId);
    this.expire();
    if (action === 'account.sessions.list') return this.list(payload.refreshWorkspaceMetadata !== false);
    if (action === 'account.login.status' || action === 'account.login.cancel') {
      this.validateLoginRequest(owner, payload.loginId);
      return action === 'account.login.status' ? this.loginStatus(owner) : this.cancelLogin(owner);
    }
    if (action === 'account.login.start') return this.startLogin(owner);
    if (action === 'account.sessions.switch') return this.switchSession(payload);
    throw new Error('account_action_unsupported');
  }

  close() {
    this.closed = true;
    this.unsubscribe();
    this.clearLoginExpiry();
    if (!this.loginStart) this.earlyCompletions.clear();
    if (this.login?.status === 'pending') {
      this.finishLogin(this.login, 'cancelled');
      if (this.login.loginId) void this.transport.request('account/login/cancel', { loginId: this.login.loginId }).catch(() => {});
    }
  }

  private async list(refreshWorkspaceMetadata: boolean) {
    let response: any;
    try { response = await this.transport.request('accountSession/list', { refreshWorkspaceMetadata }); }
    catch { throw new Error('account_list_unavailable'); }
    return this.withActiveAccount(sessionSnapshot(response));
  }

  private async withActiveAccount(snapshot: ReturnType<typeof sessionSnapshot>) {
    if (this.closed) return snapshot;
    try {
      const response = await this.transport.request('account/read', { refreshToken: false });
      const account = response?.account;
      if (account?.type !== 'chatgpt') return snapshot;
      const plan = typeof account.planType === 'string' ? account.planType.toLowerCase() : '';
      return { ...snapshot, activeAccount: {
        planType: /^[a-z][a-z0-9_]{0,63}$/.test(plan) ? plan : null,
        workspaceName: optionalText(account.workspaceName),
      } };
    } catch { return snapshot; }
  }

  private async switchSession(payload: JsonObject) {
    if (this.mutating || this.loginCancel || this.login?.status === 'pending') throw new Error('account_operation_in_progress');
    const sessionId = identifier(payload.sessionId), accountId = identifier(payload.accountId);
    this.mutating = true;
    try {
      const current = await this.list(true);
      if (this.closed) throw new Error('account_service_closed');
      const session = current.sessions.find((item: { sessionId: string }) => item.sessionId === sessionId);
      if (!session?.workspaces.some((item: { accountId: string }) => item.accountId === accountId)) {
        throw new Error('account_selection_not_available');
      }
      let result: any;
      try {
        result = await this.transport.request('accountSession/switch', { sessionId, accountId, allowBrowserLogin: false });
      } catch { throw new Error('account_switch_failed'); }
      if (result?.authUrl || result?.loginId) throw new Error('account_switch_requires_browser');
      const applied = sessionSnapshot(result);
      const active = applied.sessions.find((item: { sessionId: string }) => item.sessionId === sessionId);
      if (applied.activeSessionId !== sessionId || !active?.isActive
        || active.selectedWorkspaceAccountId !== accountId) throw new Error('account_switch_not_confirmed');
      this.accountChanged();
      return this.withActiveAccount(applied);
    } finally { this.mutating = false; }
  }

  private loginStatus(owner: string) {
    if (!this.login) return { status: 'idle' };
    if (this.login.owner !== owner) throw new Error('account_login_owned_by_other_device');
    const { status, loginId, expiresAt, verificationUrl, userCode, message } = this.login;
    return { status, ...(loginId ? { loginId } : {}), expiresAt,
      ...(verificationUrl ? { verificationUrl } : {}), ...(userCode ? { userCode } : {}), ...(message ? { message } : {}) };
  }

  private validateLoginRequest(owner: string, loginId: unknown) {
    if (!this.login) return;
    if (this.login.owner !== owner) throw new Error('account_login_owned_by_other_device');
    if (this.login.loginId && loginId !== this.login.loginId || !this.login.loginId && loginId != null) {
      throw new Error('account_login_stale');
    }
  }

  private startLogin(owner: string): Promise<any> {
    if (this.login?.status === 'pending') {
      if (this.login.owner !== owner) throw new Error('account_login_owned_by_other_device');
      if (this.loginStart) return this.loginStart;
      return Promise.resolve(this.loginStatus(owner));
    }
    if (this.mutating || this.loginCancel) throw new Error('account_operation_in_progress');
    const attempt: LoginAttempt = { owner, loginId: '', status: 'pending',
      expiresAt: this.now() + LOGIN_TIMEOUT_MS, retainUntil: 0 };
    this.login = attempt;
    this.scheduleLoginExpiry(attempt);
    this.mutating = true;
    this.earlyCompletions.clear();
    this.loginStart = this.createLogin(attempt).finally(() => {
      this.mutating = false;
      this.loginStart = null;
      this.earlyCompletions.clear();
    });
    return this.loginStart;
  }

  private async createLogin(attempt: LoginAttempt) {
    try {
      let response: any;
      try { response = await this.transport.request('account/login/start', { type: 'chatgptDeviceCode' }); }
      catch { throw new Error('account_login_start_failed'); }
      if (typeof response?.loginId === 'string') attempt.loginId = identifier(response.loginId);
      const prompt = devicePrompt(response);
      Object.assign(attempt, prompt);
      if (this.earlyCompletions.get(prompt.loginId) === true) {
        this.finishLogin(attempt, 'completed');
      } else if (this.closed || attempt.status !== 'pending' || this.now() >= attempt.expiresAt) {
        this.finishLogin(attempt, this.closed ? 'cancelled' : attempt.status === 'pending' ? 'failed' : attempt.status);
        await this.transport.request('account/login/cancel', { loginId: prompt.loginId }).catch(() => {});
      } else if (this.earlyCompletions.has(prompt.loginId)) {
        this.finishLogin(attempt, this.earlyCompletions.get(prompt.loginId) ? 'completed' : 'failed');
      }
      return this.loginStatus(attempt.owner);
    } catch (error) {
      this.finishLogin(attempt, 'failed');
      if (attempt.loginId) await this.transport.request('account/login/cancel', { loginId: attempt.loginId }).catch(() => {});
      if (error instanceof Error && /^account_/.test(error.message)) throw error;
      throw new Error('account_login_start_failed');
    }
  }

  private cancelLogin(owner: string): Promise<any> {
    if (!this.login) return Promise.resolve({ status: 'idle' });
    if (this.login.owner !== owner) throw new Error('account_login_owned_by_other_device');
    if (this.loginCancel) return this.loginCancel;
    if (this.login.status !== 'pending') return Promise.resolve(this.loginStatus(owner));
    const attempt = this.login;
    this.loginCancel = this.cancelAttempt(attempt).finally(() => { this.loginCancel = null; });
    return this.loginCancel;
  }

  private async cancelAttempt(attempt: LoginAttempt) {
    if (attempt.loginId) {
      let response: any;
      try { response = await this.transport.request('account/login/cancel', { loginId: attempt.loginId }); }
      catch { throw new Error('account_login_cancel_failed'); }
      if (attempt.status !== 'pending') return this.loginStatus(attempt.owner);
      if (response?.status !== 'canceled') {
        attempt.message = 'account_login_cancel_unconfirmed';
        throw new Error('account_login_cancel_unconfirmed');
      }
    }
    // A completion that won the race with cancellation stays authoritative.
    if (attempt.status === 'pending') this.finishLogin(attempt, 'cancelled');
    return this.loginStatus(attempt.owner);
  }

  private notification(method: string, params: JsonObject) {
    this.expire();
    const attempt = this.login;
    if (this.closed || method !== 'account/login/completed' || !attempt
      || typeof params.loginId !== 'string') return;
    if (!attempt.loginId) {
      if (attempt.status === 'pending' && this.earlyCompletions.size < 8) {
        this.earlyCompletions.set(params.loginId, params.success === true);
      }
    } else if (attempt.loginId === params.loginId) {
      if (params.success === true) this.finishLogin(attempt, 'completed');
      else if (attempt.status === 'pending') this.finishLogin(attempt, 'failed');
    }
  }

  private finishLogin(attempt: LoginAttempt, status: LoginStatus) {
    if (this.login === attempt) this.clearLoginExpiry();
    attempt.status = status;
    attempt.retainUntil = this.now() + RESULT_RETENTION_MS;
    delete attempt.verificationUrl;
    delete attempt.userCode;
    if (status === 'failed') attempt.message = 'account_login_failed';
    else delete attempt.message;
    if (status === 'completed' && !attempt.changeNotified) {
      attempt.changeNotified = true;
      this.accountChanged();
    }
  }

  private accountChanged() {
    try { void Promise.resolve(this.onAccountChanged?.()).catch(() => {}); }
    catch { /* The auth change is already committed; a UI callback cannot undo it. */ }
  }

  private clearLoginExpiry() {
    if (this.loginExpiryTimer !== null) clearTimeout(this.loginExpiryTimer);
    this.loginExpiryTimer = null;
  }

  private scheduleLoginExpiry(attempt: LoginAttempt) {
    this.clearLoginExpiry();
    this.loginExpiryTimer = setTimeout(() => {
      this.loginExpiryTimer = null;
      if (this.closed || this.login !== attempt || attempt.status !== 'pending') return;
      this.expire();
      if (attempt.status === 'pending') this.scheduleLoginExpiry(attempt);
    }, Math.max(1, attempt.expiresAt - this.now()));
    this.loginExpiryTimer.unref?.();
  }

  private expire() {
    if (!this.login) return;
    if (this.login.status === 'pending' && this.now() >= this.login.expiresAt) {
      const loginId = this.login.loginId;
      this.finishLogin(this.login, 'failed');
      this.login.message = 'account_login_expired';
      if (loginId && !this.loginCancel) {
        const attempt = this.login;
        this.loginCancel = this.transport.request('account/login/cancel', { loginId })
          .catch(() => {})
          .then(() => this.loginStatus(attempt.owner))
          .finally(() => { this.loginCancel = null; });
      }
    } else if (this.login.status !== 'pending' && this.now() >= this.login.retainUntil && !this.mutating && !this.loginCancel) {
      this.login = null;
    }
  }
}
