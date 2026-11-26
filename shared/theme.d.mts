export type Theme = 'light' | 'dark';
export type ThemePreference = Theme;
export const preferenceKey: string;
export function validPreference(value: unknown): ThemePreference;
export function readPreference(storage?: Pick<Storage, 'getItem'>): ThemePreference;
export function nextPreference(preference: unknown): ThemePreference;
export function applyTheme(preference: unknown, win?: Window): Theme;
export function mountThemeControls(root?: Document | HTMLElement, win?: Window): () => void;

export function firstPaint(key: string, backgrounds: Record<Theme, string>): void;
