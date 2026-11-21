import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountQuota, type QuotaState } from '../web/src/account-quota';

function render(state: QuotaState) {
  return renderToStaticMarkup(createElement(AccountQuota, { state }));
}

test('Codex quota shows remaining usage, reset time and individual windows once', () => {
  const primary = { usedPercent: 42.5, windowDurationMins: 300, resetsAt: 1_700_000_000 };
  const secondary = { usedPercent: 100, windowDurationMins: 10_080, resetsAt: null };
  const shared = { limitId: 'codex', limitName: null, primary, secondary };
  const alternate = { limitId: 'alternate', limitName: 'Alternate', primary: { ...primary, usedPercent: 0 }, secondary: null };
  const html = render({ status: 'ready', limits: { rateLimits: shared, rateLimitsByLimitId: { codex: shared, alternate } } });
  assert.match(html, /5 小时额度/);
  assert.match(html, /7 天额度/);
  assert.match(html, /剩余 57\.5%/);
  assert.match(html, /剩余 0%/);
  assert.match(html, /剩余 100%/);
  assert.match(html, /<h4>Alternate<\/h4>/);
  assert.match(html, /2023-11-14T22:13:20\.000Z/);
  assert.equal((html.match(/<meter /g) || []).length, 3);
});

test('Codex quota distinguishes loading, unavailable and empty results', () => {
  assert.match(render({ status: 'loading' }), /正在读取额度/);
  assert.match(render({ status: 'unavailable' }), /暂时无法读取额度/);
  assert.match(render({ status: 'ready', limits: { rateLimits: null, rateLimitsByLimitId: {} } }), /暂无可显示的额度/);
});
