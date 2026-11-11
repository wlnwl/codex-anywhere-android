import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccountService, type AccountTransport } from './account-service.js';
import type { DesktopRestartStatus } from './desktop-restart.js';

type JsonObject = Record<string, any>;
type RestartControl = {
  isSupported(): Promise<boolean>;
  restart(): Promise<DesktopRestartStatus>;
  status(id?: string): Promise<DesktopRestartStatus | null>;
};

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value);
}

/** Native authentication remains in Codex; this file stores only a restart reminder. */
export class AccountControls {
  private readonly service: AccountService;
  private restartRequired = false;
  private restartRequested = false;
  private authRevision: string = randomUUID();
  private restartRevision: string | null = null;
  private restartId: string | null = null;
  private restartSnapshot: DesktopRestartStatus | null = null;
  private restartRefresh: { id: string; promise: Promise<void> } | null = null;
  private restarting = false;
  private closed = false;
  private restartSupport: { until: number; value: Promise<boolean> } | null = null;

  constructor(transport: AccountTransport, private readonly options: {
    desktop: boolean;
    restarter: RestartControl;
    stateFile?: string;
    onAccountChanged?(): void | Promise<void>;
    isBusy?(): boolean;
  }) {
    if (options.desktop && options.stateFile) {
      try {
        const state = JSON.parse(readFileSync(options.stateFile, 'utf8'));
        this.restartRequired = state.restartRequired === true;
        if (state.version === 2 && validId(state.authRevision)) this.authRevision = state.authRevision;
        if (state.version === 2 && validId(state.restartId) && validId(state.restartRevision)) {
          this.restartId = state.restartId;
          this.restartRevision = state.restartRevision;
          this.restartRequested = state.restartRequested === true;
        }
      }
      catch { /* A missing reminder does not affect native authentication. */ }
    }
    this.service = new AccountService(transport, { onAccountChanged: () => {
      this.restartRequired = options.desktop;
      this.restartRequested = false;
      this.authRevision = randomUUID();
      this.saveReminder();
      return options.onAccountChanged?.();
    } });
  }

  async dispatch(action: string, payload: JsonObject, owner: string): Promise<any> {
    if (this.closed) throw new Error('account_service_closed');
    if (action === 'account.desktop.restart.status') {
      if (payload.restartId !== undefined && payload.restartId !== this.restartId) {
        throw new Error('account_desktop_restart_stale');
      }
      await this.refreshRestart();
      return this.withRestartState({});
    }
    if (action === 'account.desktop.restart') {
      if (payload.confirm !== true) throw new Error('account_desktop_restart_confirmation_required');
      if (!this.options.desktop) throw new Error('account_desktop_restart_unavailable');
      if (this.restarting) throw new Error('account_operation_in_progress');
      if (this.options.isBusy?.()) throw new Error('account_active_turn');
      this.restarting = true;
      try {
        await this.refreshRestart();
        if (this.closed) throw new Error('account_service_closed');
        if (this.restartIsPending()) return this.withRestartState({});
        if (this.options.isBusy?.()) throw new Error('account_active_turn');
        const revision = this.authRevision;
        const submittedAt = Date.now();
        const result = await this.options.restarter.restart();
        if (!validId(result?.id)) throw new Error('account_desktop_restart_failed');
        const previousId = this.restartId;
        this.restartId = result.id;
        // The restarter may recover a helper started by an earlier connector.
        // Only a fresh operation can be associated with the account selected now.
        if (result.id !== previousId) {
          this.restartRevision = typeof result.startedAt === 'number' && result.startedAt >= submittedAt ? revision : null;
        }
        this.applyRestart(result);
        this.saveReminder();
        return this.withRestartState({});
      } catch (error) {
        if (error instanceof Error && ['account_service_closed', 'account_active_turn'].includes(error.message)) throw error;
        throw new Error('account_desktop_restart_failed');
      }
      finally { this.restarting = false; }
    }
    if (action === 'account.sessions.switch' || action === 'account.login.start') {
      await this.refreshRestart();
      if (this.closed) throw new Error('account_service_closed');
      if (this.restarting || this.restartIsPending()) throw new Error('account_operation_in_progress');
      if (this.options.isBusy?.()) throw new Error('account_active_turn');
    }
    const result = await this.service.dispatch(action, payload, owner);
    await this.refreshRestart();
    return this.withRestartState(result);
  }

  close() { this.closed = true; this.service.close(); }

  private restartIsPending() {
    return this.restartSnapshot?.status === 'pending' || this.restartSnapshot?.status === 'restarting';
  }

  private async withRestartState(result: JsonObject) {
    const supported = await this.isRestartSupported();
    return { ...result, restart: this.restartSnapshot, desktopRestartRequired: this.restartRequired,
      desktopRestartRequested: this.restartRequested, desktopRestartSupported: supported };
  }

  private refreshRestart(): Promise<void> {
    const id = this.restartId;
    if (!id || this.closed) return Promise.resolve();
    if (this.restartRefresh?.id === id) return this.restartRefresh.promise;
    const promise = this.readRestart(id).finally(() => {
      if (this.restartRefresh?.promise === promise) this.restartRefresh = null;
    });
    this.restartRefresh = { id, promise };
    return promise;
  }

  private async readRestart(id: string) {
    let snapshot: DesktopRestartStatus | null;
    try { snapshot = await this.options.restarter.status(id); }
    catch { snapshot = null; }
    if (this.restartId !== id || this.closed) return;
    this.applyRestart(snapshot?.id === id ? snapshot : {
      id, status: 'unknown', error: 'desktop_restart_status_unavailable',
    });
    this.saveReminder();
  }

  private applyRestart(snapshot: DesktopRestartStatus) {
    this.restartSnapshot = snapshot;
    const sameAccount = this.restartRevision === this.authRevision;
    if (snapshot.status === 'completed' && sameAccount) this.restartRequired = false;
    this.restartRequested = sameAccount && (snapshot.status === 'pending' || snapshot.status === 'restarting'
      || snapshot.status === 'completed');
  }

  private isRestartSupported(): Promise<boolean> {
    if (!this.options.desktop) return Promise.resolve(false);
    if (!this.restartSupport || Date.now() >= this.restartSupport.until) {
      this.restartSupport = { until: Date.now() + 60_000,
        value: this.options.restarter.isSupported().catch(() => false) };
    }
    return this.restartSupport.value;
  }

  private saveReminder() {
    if (!this.options.stateFile || !this.options.desktop) return;
    const temporary = `${this.options.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ version: 2, restartRequired: this.restartRequired,
        restartRequested: this.restartRequested, authRevision: this.authRevision,
        restartRevision: this.restartRevision, restartId: this.restartId }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.options.stateFile);
    } catch { /* The live reminder is still available; never mask a successful login. */ }
    finally {
      try { rmSync(temporary, { force: true }); }
      catch { /* Cleanup failure cannot change the result of native authentication. */ }
    }
  }
}
