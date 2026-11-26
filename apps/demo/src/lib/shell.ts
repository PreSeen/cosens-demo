// Shared demo header: wordmark, status chips slot, account email, EN/中文 switch, theme switch (site preference) and the sign-out button.
import { localeControlHtml, mountLocaleControls } from '../../../../shared/i18n.mjs';
import { mountThemeControls } from '../../../../shared/theme.mjs';
import { api, type Me } from './api';

const ICON = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const SUN = `<svg ${ICON}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const MOON = `<svg ${ICON}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;

export type Shell = {
  header: HTMLElement;
  status: HTMLElement;
  ready: Promise<Me | null>;
  setAccount(me: Me | null): void;
};

export function mountShell(header: HTMLElement, { loadAccount = true }: { loadAccount?: boolean } = {}): Shell {
  header.className = 'demo-header';
  header.innerHTML = `<a class="demo-brand" href="/demo/" data-i18n-aria-label="shell.hub_label"><span class="cs-wordmark-pair"><img class="cs-wordmark cs-wordmark-light" src="/assets/cosens-logo.png" width="132" height="32" alt="CoSens"><img class="cs-wordmark cs-wordmark-dark" src="/assets/cosens-logo-on-dark.png" width="132" height="32" alt="CoSens"></span><span class="demo-brand-label" data-i18n="shell.brand_label"></span></a><div class="status" data-shell-status></div><div class="demo-account"><span class="demo-email" data-shell-email hidden></span><a class="demo-source" href="https://github.com/PreSeen/cosens-demo" target="_blank" rel="noreferrer">GitHub</a>${localeControlHtml()}<button class="cs-theme-control" type="button" data-theme-control aria-label="Switch between light and dark" title="Switch between light and dark"><span class="cs-theme-current-icon" data-theme-icon="light">${SUN}</span><span class="cs-theme-current-icon" data-theme-icon="dark">${MOON}</span></button><button class="give" type="button" data-shell-logout data-i18n="shell.logout" hidden></button></div>`;
  // The page sets id="root", so the build's theme bootstrap does not add a second document-level listener.
  mountThemeControls(header);
  // Next to the theme switch: fills the data-i18n texts of the header and follows the visitor's choice.
  mountLocaleControls(header);
  const status = header.querySelector<HTMLElement>('[data-shell-status]')!;
  const email = header.querySelector<HTMLElement>('[data-shell-email]')!;
  const logout = header.querySelector<HTMLButtonElement>('[data-shell-logout]')!;
  const setAccount = (me: Me | null): void => {
    email.textContent = me?.email ?? '';
    email.title = me?.email ?? '';
    email.hidden = !me?.email;
    logout.hidden = !me;
  };
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try { await api.logout(); } catch { /* Leave either way; an unreachable logout still drops the page. */ }
    location.assign('/');
  });
  const ready = loadAccount ? api.me().then(me => { setAccount(me); return me; }, () => null) : Promise.resolve(null);
  return { header, status, ready, setAccount };
}
