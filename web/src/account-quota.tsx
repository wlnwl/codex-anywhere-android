import { dateLocale, t } from './i18n';

type LimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};
type Limit = {
  limitId: string | null;
  limitName: string | null;
  primary: LimitWindow | null;
  secondary: LimitWindow | null;
};
export type RateLimits = {
  rateLimits: Limit | null;
  rateLimitsByLimitId: Record<string, Limit> | null;
};
export type QuotaState =
  | { status: 'loading' | 'unavailable' }
  | { status: 'ready'; limits: RateLimits };

const percentage = new Intl.NumberFormat(dateLocale, { style: 'percent', maximumFractionDigits: 1 });
const resetDate = new Intl.DateTimeFormat(dateLocale, {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

function windowLabel(minutes: number | null, role: 'primary' | 'secondary') {
  if (minutes && minutes % 1440 === 0) {
    const days = minutes / 1440;
    return t(`${days} 天额度`, `${days}-day limit`);
  }
  if (minutes && minutes % 60 === 0) {
    const hours = minutes / 60;
    return t(`${hours} 小时额度`, `${hours}-hour limit`);
  }
  if (minutes) return t(`${minutes} 分钟额度`, `${minutes}-minute limit`);
  return role === 'primary' ? t('主要时段', 'Primary window') : t('次要时段', 'Secondary window');
}

function quotaGroups(limits: RateLimits) {
  const entries = new Map(Object.entries(limits?.rateLimitsByLimitId || {}));
  const legacy = limits?.rateLimits;
  const mainId = legacy?.limitId || 'codex';
  const main = entries.get(mainId) ?? legacy;
  entries.delete(mainId);
  const groups = main ? [[mainId, main] as const, ...entries] : [...entries];
  return groups.flatMap(([id, limit]) => {
    const windows = (['primary', 'secondary'] as const).flatMap(role => {
      const window = limit?.[role];
      return window && Number.isFinite(window.usedPercent) ? [{ role, window }] : [];
    });
    return windows.length ? [{ id, name: limit.limitName || id, windows }] : [];
  });
}

export function AccountQuota({ state }: { state: QuotaState }) {
  const groups = state.status === 'ready' ? quotaGroups(state.limits) : [];
  const notice = state.status === 'loading'
    ? t('正在读取额度…', 'Loading limits…')
    : state.status === 'unavailable'
      ? t('暂时无法读取额度，请刷新后重试。', 'Could not load limits. Refresh to try again.')
      : t('当前账号暂无可显示的额度。', 'No limits are available for this account.');
  return (
    <div className="account-dialog-quota">
      <h3>{t('Codex 额度', 'Codex limits')}</h3>
      {!groups.length && <p role="status">{notice}</p>}
      {groups.map(({ id, name, windows }) => (
        <div className="account-quota-group" key={id}>
          {(groups.length > 1 || id !== 'codex') && <h4>{id === 'codex' ? 'Codex' : name}</h4>}
          {windows.map(({ role, window }) => {
            const label = windowLabel(window.windowDurationMins, role);
            const remaining = Math.min(100, Math.max(0, 100 - window.usedPercent));
            const formatted = percentage.format(remaining / 100);
            const reset = window.resetsAt ? new Date(window.resetsAt * 1000) : null;
            return (
              <div className="account-quota-window" key={role}>
                <div>
                  <span>{label}</span>
                  <strong>{t(`剩余 ${formatted}`, `${formatted} remaining`)}</strong>
                </div>
                <meter min={0} max={100} value={remaining} aria-label={label} />
                {reset && Number.isFinite(reset.getTime()) && (
                  <p>{t('重置于', 'Resets')} <time dateTime={reset.toISOString()}>{resetDate.format(reset)}</time></p>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
