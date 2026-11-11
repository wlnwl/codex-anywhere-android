import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { BridgeRequest } from './bridge-request-manager';
import { t } from './i18n';
import './account-dialog.css';

type Workspace = { accountId: string; name: string | null; kind: string | null };
type AccountSession = {
  sessionId: string;
  email: string | null;
  displayName: string | null;
  isActive: boolean;
  selectedWorkspaceAccountId: string | null;
  workspaces: Workspace[];
};
type RestartStatus = {
  id: string;
  status: 'pending' | 'restarting' | 'completed' | 'failed' | 'unknown';
  error?: string;
};
type RestartState = {
  desktopRestartRequired: boolean;
  desktopRestartSupported: boolean;
  restart: RestartStatus | null;
};
type AccountList = RestartState & {
  activeSessionId: string | null;
  activeAccount?: { planType: string | null; workspaceName: string | null };
  sessions: AccountSession[];
};
type LoginStatus = RestartState & {
  status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'idle';
  loginId?: string;
  verificationUrl?: string;
  userCode?: string;
  message?: string;
};
type LoginPrompt = { id: string; url: string; code: string };
type Confirmation = { kind: 'switch'; sessionId: string; accountId: string; label: string } | { kind: 'restart' };

const POLL_INTERVAL_MS = 2_000;

function accountError(cause: unknown) {
  const code = (cause instanceof Error ? cause.message : String(cause ?? '')).toLowerCase();
  if (code.includes('active_turn')) return t('电脑上的任务正在运行，请等待任务结束后再试。', 'Wait for the task on the computer to finish before trying again.');
  if (code.includes('operation_in_progress')) return t('另一项账号操作正在进行，请稍后重试。', 'Another account operation is in progress. Try again shortly.');
  if (code.includes('owned_by_other_device')) return t('请在发起登录的设备上完成或取消登录。', 'Complete or cancel sign-in on the device that started it.');
  if (code.includes('login_expired') || code.includes('login_stale')) return t('这次登录已失效，请重新发起。', 'This sign-in has expired. Start a new one.');
  if (code.includes('login_cancel_unconfirmed')) return t('取消结果尚未确认，请查看登录状态。', 'Cancellation has not been confirmed. Check the sign-in status.');
  if (code.includes('switch_requires_browser')) return t('此账号需要重新验证，请使用“登录其他账号”。', 'This account needs verification. Use “Sign in to another account.”');
  if (code.includes('selection_not_available') || code.includes('switch_not_confirmed')) return t('无法确认此账号和工作区，请刷新列表后重试。', 'This account and workspace could not be confirmed. Refresh the list and try again.');
  if (code.includes('unsupported') || /unknown[_ ]action|method not found/.test(code)) return t('请更新电脑连接器和 Codex 以使用账号管理。', 'Update the computer connector and Codex to manage accounts.');
  if (code.includes('list_unavailable')) return t('电脑暂时无法读取账号列表，请稍后刷新。', 'The computer could not read its account list. Refresh it shortly.');
  if (code.includes('desktop_restart')) return t('无法确认自动重启。请在电脑上退出 Codex 后重新打开。', 'Automatic restart could not be confirmed. Quit and reopen Codex on the computer.');
  if (code.includes('timeout')) return t('电脑响应超时，请检查连接后重试。', 'The computer took too long to respond. Check the connection and try again.');
  return t('账号操作未完成，请检查电脑连接后重试。', 'The account operation did not finish. Check the computer connection and try again.');
}

function workspaceLabel(workspace: Workspace) {
  if (workspace.name?.trim()) return workspace.name;
  switch (workspace.kind?.toLowerCase()) {
    case 'personal': return t('个人工作区', 'Personal workspace');
    case 'team':
    case 'business': return t('Business 工作区', 'Business workspace');
    case 'enterprise': return t('企业工作区', 'Enterprise workspace');
    default: return t('工作区', 'Workspace');
  }
}

function planLabel(plan: string | null | undefined) {
  if (!plan) return '';
  if (plan === 'team' || plan === 'business') return 'Business';
  return plan[0].toUpperCase() + plan.slice(1);
}

function safeLoginPrompt(reply: LoginStatus): LoginPrompt {
  const url = new URL(reply.verificationUrl || '');
  if (!reply.loginId || !reply.userCode || !/^[A-Za-z0-9-]{4,32}$/.test(reply.userCode)
    || url.origin !== 'https://auth.openai.com' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/codex/device') {
    throw new Error('account_login_response_invalid');
  }
  return { id: reply.loginId, url: url.href, code: reply.userCode };
}

function restartLabel(state: RestartState | null) {
  const restart = state?.restart;
  if (restart?.status === 'pending' || restart?.status === 'restarting') {
    return t('正在重启电脑上的 Codex…', 'Restarting Codex on the computer…');
  }
  if (restart?.status === 'failed' || restart?.status === 'unknown') {
    if (restart.error?.includes('timeout')) return t('等待电脑上的 Codex 重启超时。', 'Timed out waiting for Codex to restart.');
    if (restart.error?.includes('stop_failed')) return t('电脑上的 Codex 未能退出。', 'Codex could not quit on the computer.');
    if (restart.error?.includes('activation_failed')) return t('电脑上的 Codex 未能重新启动。', 'Codex could not reopen on the computer.');
    return t('未能确认 Codex 已重启。', 'Codex restart could not be confirmed.');
  }
  if (state?.desktopRestartRequired) {
    return t('账号选择已保存，重启电脑上的 Codex 后生效。', 'The saved account selection takes effect after Codex restarts.');
  }
  return restart?.status === 'completed' ? t('已确认电脑上的 Codex 重新启动。', 'Codex has restarted on the computer.') : '';
}

export function AccountDialog({ deviceLabel, request, onClose }: {
  deviceLabel: string;
  request: BridgeRequest;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const [accounts, setAccounts] = useState<AccountList | null>(null);
  const [restartState, setRestartState] = useState<RestartState | null>(null);
  const [login, setLogin] = useState<LoginPrompt | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const restart = restartState?.restart;
  const restartPending = restart?.status === 'pending' || restart?.status === 'restarting';
  const restartMessage = restartLabel(restartState);

  const refresh = useCallback(async (signal: AbortSignal) => {
    const result = await request<AccountList>('account.sessions.list', { refreshWorkspaceMetadata: true }, { signal });
    if (signal.aborted) return;
    if (!Array.isArray(result?.sessions)) throw new Error('account_response_invalid');
    setAccounts(result);
    setRestartState(result);
  }, [request]);

  const run = useCallback(async (action: (signal: AbortSignal) => Promise<void>) => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || operation.current) return;
    operation.current = controller;
    setBusy(true);
    setError('');
    try { await action(controller.signal); }
    catch (cause) { if (!controller.signal.aborted) setError(accountError(cause)); }
    finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void run(refresh);
    return () => {
      controller.abort();
      if (operation.current === controller) operation.current = null;
      if (lifetime.current === controller) lifetime.current = null;
    };
  }, [refresh, run]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const acceptLogin = useCallback((result: LoginStatus, signal: AbortSignal) => {
    if (signal.aborted) return false;
    setRestartState(result);
    if (result.status === 'pending') {
      setLogin(safeLoginPrompt(result));
      return false;
    }
    setLogin(null);
    if (result.status === 'completed') {
      setNotice(t('登录完成。', 'Sign-in complete.'));
      return true;
    } else if (result.status === 'cancelled') {
      setNotice(t('登录已取消。', 'Sign-in cancelled.'));
    } else {
      setError(accountError(result.message || 'account_login_expired'));
    }
    return false;
  }, []);

  const loginId = login?.id;
  const restartId = restartPending ? restart?.id : undefined;
  useEffect(() => { dialogRef.current?.focus(); }, [confirmation, loginId]);

  useEffect(() => {
    if (busy || !loginId && !restartId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    const poll = async () => {
      if (signal.aborted || reading || document.hidden) return;
      if (operation.current) {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }
      reading = true;
      try {
        if (loginId) {
          const result = await request<LoginStatus>('account.login.status', { loginId }, { signal });
          if (!signal.aborted && !operation.current) {
            setError('');
            if (acceptLogin(result, signal)) void run(refresh);
          }
        } else {
          const result = await request<RestartState>('account.desktop.restart.status', { restartId }, { signal });
          if (!signal.aborted && !operation.current) {
            setError('');
            setRestartState(result);
          }
        }
      } catch (cause) {
        if (!signal.aborted && !operation.current) {
          const message = cause instanceof Error ? cause.message : '';
          if (message === 'account_desktop_restart_stale') {
            try { await refresh(signal); }
            catch (failure) { if (!signal.aborted) setError(accountError(failure)); }
          } else {
            if (message === 'account_login_stale' || message === 'account_login_owned_by_other_device') setLogin(null);
            setError(accountError(cause));
          }
        }
      } finally {
        reading = false;
        if (!signal.aborted && !document.hidden) timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    timer = setTimeout(poll, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [acceptLogin, busy, loginId, refresh, request, restartId, run]);

  const confirm = () => {
    const choice = confirmation;
    if (!choice) return;
    void run(async signal => {
      if (choice.kind === 'restart') {
        const result = await request<RestartState>('account.desktop.restart', { confirm: true }, { signal });
        if (!signal.aborted) setRestartState(result);
      } else {
        const result = await request<AccountList>('account.sessions.switch', {
          sessionId: choice.sessionId, accountId: choice.accountId,
        }, { signal });
        if (signal.aborted) return;
        setAccounts(result);
        setRestartState(result);
        setNotice(t('已保存账号选择。', 'Account selection saved.'));
      }
      if (!signal.aborted) setConfirmation(null);
    });
  };

  const startLogin = () => void run(async signal => {
    setNotice('');
    if (acceptLogin(await request<LoginStatus>('account.login.start', {}, { signal }), signal)) await refresh(signal);
  });
  const cancelLogin = (loginId: string) => void run(async signal => {
    if (acceptLogin(await request<LoginStatus>('account.login.cancel', { loginId }, { signal }), signal)) await refresh(signal);
  });
  const close = () => {
    if (confirmation && !busy) setConfirmation(null);
    else onClose();
  };

  return (
    <div className="new-session-overlay account-dialog-overlay" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) close();
    }}>
      <section
        ref={dialogRef} tabIndex={-1} className="new-session-dialog account-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); close(); }
          if (event.key !== 'Tab') return;
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
          const first = controls[0], last = controls.at(-1);
          if (!first) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
            event.preventDefault(); last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
          }
        }}
      >
        <header className="new-session-dialog-head account-dialog-head">
          <div><h2 id={titleId}>{t('Codex 账号', 'Codex accounts')}</h2><p>{deviceLabel}</p></div>
          <button type="button" aria-label={t('关闭', 'Close')} onClick={onClose}>×</button>
        </header>
        <div className="new-session-dialog-body account-dialog-body" aria-busy={busy}>
          {confirmation ? (
            <div className="account-dialog-confirm">
              <h3>{confirmation.kind === 'restart'
                ? t('重启这台电脑上的 Codex？', 'Restart Codex on this computer?')
                : t('切换 Codex 账号或工作区？', 'Switch Codex account or workspace?')}</h3>
              <p>{confirmation.kind === 'restart'
                ? t('重启会中断电脑上的 Codex 任务。', 'Restarting interrupts Codex tasks on the computer.')
                : confirmation.label}</p>
            </div>
          ) : login ? (
            <div className="account-dialog-login">
              <h3>{t('使用设备码登录', 'Sign in with a device code')}</h3>
              <p>{t('打开 OpenAI 登录页面，登录要使用的账号并输入此设备码。', 'Open the OpenAI sign-in page, sign in to the account you want, and enter this code.')}</p>
              <code>{login.code}</code>
              <a className="account-dialog-action" href={login.url} target="_blank" rel="noopener noreferrer">{t('打开 OpenAI 登录页面', 'Open OpenAI sign-in')}</a>
            </div>
          ) : (
            <>
              {restartMessage && (
                <div className="account-dialog-status" role="status">
                  <p>{restartMessage}</p>
                  {restartState?.desktopRestartRequired && !restartPending && (restartState.desktopRestartSupported
                    ? <button type="button" className="account-dialog-action" disabled={busy} onClick={() => setConfirmation({ kind: 'restart' })}>{t('重启 Codex', 'Restart Codex')}</button>
                    : <p>{t('请在电脑上退出并重新打开 Codex。', 'Quit and reopen Codex on the computer.')}</p>)}
                </div>
              )}
              {accounts?.activeAccount?.planType && <p className="account-dialog-plan">
                {t('当前订阅', 'Current plan')} · {planLabel(accounts.activeAccount.planType)}
              </p>}
              {accounts && accounts.sessions.length === 0 && <p>{t('这台电脑没有已登录的 Codex 账号。', 'No Codex accounts are signed in on this computer.')}</p>}
              {!accounts && busy && <p role="status">{t('正在读取账号和工作区…', 'Loading accounts and workspaces…')}</p>}
              {accounts?.sessions.map(session => {
                const name = session.displayName || session.email || t('Codex 账号', 'Codex account');
                return (
                  <div className="account-dialog-session" key={session.sessionId}>
                    <h3>{name}</h3>
                    {session.email && session.email !== name && <p>{session.email}</p>}
                    {!session.workspaces.length && <p>{t('此账号暂无可切换的工作区。', 'This account has no selectable workspaces.')}</p>}
                    <ul>
                      {session.workspaces.map(workspace => {
                        const active = (session.isActive || session.sessionId === accounts.activeSessionId)
                          && workspace.accountId === session.selectedWorkspaceAccountId;
                        const label = workspaceLabel(workspace);
                        return (
                          <li key={workspace.accountId}>
                            <span>{label}</span>
                            {active ? <strong>{t('已选择', 'Selected')}</strong>
                              : <button type="button" className="account-dialog-action" disabled={busy || restartPending}
                                onClick={() => setConfirmation({ kind: 'switch', sessionId: session.sessionId, accountId: workspace.accountId, label: `${name} · ${label}` })}>
                                {t('切换', 'Switch')}
                              </button>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </>
          )}
          {notice && !login && !confirmation && <p role="status">{notice}</p>}
          {error && <p className="new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="new-session-dialog-actions account-dialog-actions">
          {confirmation ? (
            <>
              <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>{t('取消', 'Cancel')}</button>
              <button type="button" className="primary-action" disabled={busy} onClick={confirm}>
                {busy ? t('正在处理…', 'Working…') : confirmation.kind === 'restart' ? t('确认重启', 'Confirm restart') : t('确认切换', 'Confirm switch')}
              </button>
            </>
          ) : login ? (
            <button type="button" disabled={busy} onClick={() => cancelLogin(login.id)}>{t('取消登录', 'Cancel sign-in')}</button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => void run(refresh)}>{t('刷新', 'Refresh')}</button>
              <button type="button" className="primary-action" disabled={busy || restartPending} onClick={startLogin}>{t('登录其他账号', 'Sign in to another account')}</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
