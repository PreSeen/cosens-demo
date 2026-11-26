import { palettes } from './theme-tokens.mjs';

export const preferenceKey = 'cosens-theme-preference';
export const validPreference = value => value === 'light' ? 'light' : 'dark';

export function readPreference(storage) {
  try { return validPreference((storage ?? globalThis.localStorage)?.getItem(preferenceKey)); }
  catch { return 'dark'; }
}

export function nextPreference(preference) {
  return validPreference(preference) === 'light' ? 'dark' : 'light';
}

export function applyTheme(preference, win = window) {
  const theme = validPreference(preference);
  const doc = win.document;
  doc.documentElement.dataset.theme = theme;
  doc.documentElement.style.colorScheme = theme;
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = palettes[theme].bg;
  const label = theme === 'dark' ? 'Color theme: Dark. Switch to Light.' : 'Color theme: Light. Switch to Dark.';
  doc.querySelectorAll('[data-theme-control]').forEach(control => {
    control.setAttribute('aria-label', label);
    control.setAttribute('title', label);
  });
  win.dispatchEvent(new win.CustomEvent('cosens:themechange', { detail: { theme, preference: theme } }));
  return theme;
}

// Called after hydration on React pages; listeners are removed on route changes/StrictMode cleanup.
export function mountThemeControls(root = document, win = window) {
  let preference = validPreference(win.document.documentElement.dataset.theme ?? readPreference());
  let inMemoryOverride = false;
  const sync = () => applyTheme(preference, win);
  const click = event => {
    if (!event.target.closest?.('[data-theme-control]')) return;
    preference = nextPreference(preference);
    try { win.localStorage.setItem(preferenceKey, preference); inMemoryOverride = false; }
    catch { inMemoryOverride = true; }
    sync();
  };
  const storageChange = event => {
    if (event.key === preferenceKey || event.key === null) {
      inMemoryOverride = false;
      preference = event.key === null ? 'dark' : validPreference(event.newValue);
      sync();
    }
  };
  const pageShow = () => {
    try { if (!inMemoryOverride) preference = validPreference(win.localStorage.getItem(preferenceKey)); } catch { /* Preserve in-memory choice on restored pages. */ }
    sync();
  };
  root.addEventListener('click', click);
  win.addEventListener('storage', storageChange);
  win.addEventListener('pageshow', pageShow);
  sync();
  return () => {
    root.removeEventListener('click', click);
    win.removeEventListener('storage', storageChange);
    win.removeEventListener('pageshow', pageShow);
  };
}

// Serialized into <head>; keep this function self-contained and safe before styles or React load.
export function firstPaint(key, backgrounds) {
  let theme = 'dark';
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'light') theme = saved;
  } catch { /* Storage can be denied. */ }
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = backgrounds[theme];
}
