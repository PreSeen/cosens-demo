import type { Theme } from './theme.mjs';
export const palettes: Record<Theme, Record<string, string>>;
export const themePaintCss: string;
export function toOklch(hex: string): string;
