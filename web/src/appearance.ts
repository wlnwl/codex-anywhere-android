export type Appearance = 'day' | 'night';

const storageKey = 'codex-anywhere.appearance';
const listeners = new Set<() => void>();
let current: Appearance = 'night';

function applyAppearance(appearance: Appearance) {
  document.documentElement.dataset.theme = appearance;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', appearance === 'day' ? '#f4f7fc' : '#0b0f19');
}

export function initializeAppearance() {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'day' || saved === 'night') current = saved;
  } catch { /* Use the default theme when storage is blocked. */ }
  applyAppearance(current);
}

export const getAppearance = () => current;

export function subscribeAppearance(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setAppearance(appearance: Appearance) {
  if (appearance === current) return;
  current = appearance;
  applyAppearance(appearance);
  try { localStorage.setItem(storageKey, appearance); }
  catch { /* The selected theme still applies for this page. */ }
  for (const listener of listeners) listener();
}
