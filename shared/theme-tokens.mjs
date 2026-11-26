// One source for CSS, first paint, browser chrome and GPU/canvas illustrations.
export const palettes = {
  light: {
    brand: '#A0C353', 'on-brand': '#20241A', bg: '#FFFFFF', surface: '#FFFFFF',
    soft: '#F7F8F7', 'section-bg': '#F7F8F7', hover: '#EEF0ED', ink: '#1D211E', muted: '#515952',
    line: '#DFE3DE', boundary: '#7A827A', accent: '#526D28', tint: '#F0F3E5',
    'brand-hover': '#ACCF60', 'brand-pressed': '#95B548',
    'disabled-bg': '#EEF0ED', 'disabled-ink': '#515952',
    success: '#236345', 'success-bg': '#E4F1E8', 'success-line': '#608670',
    warning: '#795014', 'warning-bg': '#FAEED7', 'warning-line': '#9B7842',
    error: '#A23038', 'error-bg': '#FBEAEC', 'error-line': '#B96C72',
    info: '#275E8A', 'info-bg': '#E7EFF8', 'info-line': '#6988A5',
    'code-bg': '#F7F8F7', 'code-ink': '#1D211E', 'code-comment': '#515952',
    'code-keyword': '#70518C', 'code-string': '#356331', 'code-number': '#89511E', 'code-function': '#275E8A',
    'media-bg': '#15180F', 'media-ink': '#F0F3E7', 'media-muted': '#BCC4AD',
  },
  dark: {
    brand: '#C3F25C', 'on-brand': '#151719', bg: '#0C0D0E', surface: '#0F1113',
    soft: '#15181B', 'section-bg': '#101214', hover: '#202327', ink: '#F5F6F7', muted: '#ADB2B9',
    line: '#41464D', boundary: '#858C95', accent: '#C3F25C', tint: '#191D1F',
    'brand-hover': '#D1F977', 'brand-pressed': '#B1E14A',
    'disabled-bg': '#202327', 'disabled-ink': '#ADB2B9',
    success: '#9ED8B4', 'success-bg': '#20352A', 'success-line': '#73A587',
    warning: '#EDC781', 'warning-bg': '#382E1B', 'warning-line': '#B29359',
    error: '#F2A5AC', 'error-bg': '#3B2329', 'error-line': '#C58088',
    info: '#A4CAED', 'info-bg': '#1F3041', 'info-line': '#759ABA',
    'code-bg': '#0F1113', 'code-ink': '#F5F6F7', 'code-comment': '#ADB2B9',
    'code-keyword': '#D6B6EF', 'code-string': '#C2E47E', 'code-number': '#E8BF87', 'code-function': '#A4CAED',
    'media-bg': '#0C0D0E', 'media-ink': '#F5F6F7', 'media-muted': '#ADB2B9',
  },
};

// Convert the authored sRGB palette to equivalent OKLCH without a build dependency.
export function toOklch(hex) {
  const [r, g, b] = hex.match(/\w\w/g).map(v => {
    const c = parseInt(v, 16) / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b);
  const m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b);
  const s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
  const L = .2104542553*l + .793617785*m - .0040720468*s;
  const a = 1.9779984951*l - 2.428592205*m + .4505937099*s;
  const c = .0259040371*l + .7827717662*m - .808675766*s;
  return `oklch(${(L*100).toFixed(6)}% ${Math.hypot(a,c).toFixed(7)} ${((Math.atan2(c,a)*180/Math.PI+360)%360).toFixed(5)})`;
}

const declarations = theme => Object.entries(palettes[theme]).map(([key, value]) =>
  `--palette-${key}:${key.startsWith('brand') || key === 'on-brand' ? value : toOklch(value)};`
).join('') + `color-scheme:${theme};background:var(--palette-bg);color:var(--palette-ink)`;

export const themePaintCss = `:root{${declarations('dark')}}\n:root[data-theme=light]{${declarations('light')}}`;
