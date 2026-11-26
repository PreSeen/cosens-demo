import { defineConfig } from 'vite';
import { themePaintCss, palettes } from '../../shared/theme-tokens.mjs';
import { firstPaint, preferenceKey } from '../../shared/theme.mjs';
// Each page is its own HTML entry so /demo/ and /demo/investor/ are static files behind the page gate.
export default defineConfig({ base: '/demo/', plugins: [{
  name: 'cosens-first-paint',
  transformIndexHtml(html) {
    const backgrounds = { light: palettes.light.bg, dark: palettes.dark.bg };
    const bootstrap = `<!-- theme-paint:start --><style id="theme-paint">${themePaintCss}</style><script id="theme-bootstrap">(${firstPaint.toString()})(${JSON.stringify(preferenceKey)},${JSON.stringify(backgrounds)});</script><!-- theme-paint:end -->`;
    return html.replace(/<meta[^>]*name="theme-color"[^>]*>/g, '').replace('<head>', `<head><meta name="theme-color" content="${backgrounds.dark}">${bootstrap}`);
  },
}], build: { outDir: '../../dist/demo', emptyOutDir: true, assetsDir: '_app', rollupOptions: { input: { hub: 'index.html', investor: 'investor/index.html' } } } });
