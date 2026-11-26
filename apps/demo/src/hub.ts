// /demo/: list of demos. The investor demo comes first; later demos add one entry to DEMOS.
import './lib/boot-locale';
import './styles/demo.css';
import { t } from '../../../shared/i18n.mjs';
import { mountShell } from './lib/shell';
import { api, loginUrl, type RunSummary } from './lib/api';
import { esc, hubRunsText, loginErrorBanner } from './lib/logic.mjs';

type DemoEntry = { id: string; href: string };

const DEMOS: DemoEntry[] = [{ id: 'investor', href: '/demo/investor/' }];

const card = (demo: DemoEntry): string => `<a class="demo-card fade" href="${esc(demo.href)}" data-demo="${esc(demo.id)}"><h2>${esc(t(`demo.${demo.id}.title`))}</h2><p>${esc(t(`demo.${demo.id}.summary`))}</p><div class="steps">${[1, 2, 3].map(step => `<span>${esc(t(`demo.${demo.id}.step${step}`))}</span>`).join('')}</div><p class="meta note">${esc(t(`demo.${demo.id}.note`))}</p><p class="meta note" data-runs hidden></p><div class="go">${esc(t('hub.go'))}</div></a>`;

const list = document.getElementById('demos')!;
const banner = document.getElementById('loginError')!;

/** What the runs line says: nothing yet, the list of runs, or that it could not be read. Kept so a language switch can redraw it. */
let runsState: { runs: RunSummary[] } | 'failed' | null = null;

function setRunsText(): void {
  const node = list.querySelector<HTMLElement>('[data-demo="investor"] [data-runs]');
  if (!node) return;
  const text = runsState === 'failed' ? t('hub.runs_failed') : runsState ? hubRunsText(runsState.runs) : '';
  node.textContent = text;
  node.hidden = !text;
}

function renderCards(): void {
  list.innerHTML = DEMOS.map(card).join('');
  setRunsText();
}

async function loadRuns(): Promise<void> {
  try { runsState = { runs: await api.listRuns() }; }
  catch { runsState = 'failed'; }
  setRunsText();
}

const params = new URLSearchParams(location.search);
const loginError = params.get('login_error');
const shell = mountShell(document.getElementById('shell')!, { loadAccount: !loginError });
let bannerState: { signedIn: boolean } | null = null;

// A visitor may still hold an older session: then only the last sign-in attempt failed, and the banner says so.
function renderBanner(): void {
  if (!bannerState || !loginError) return;
  banner.classList.toggle('info', bannerState.signedIn);
  banner.innerHTML = `<span>${esc(loginErrorBanner(loginError, bannerState.signedIn))}</span><a class="primary" href="${esc(loginUrl('/demo/'))}">${esc(t('login.retry'))}</a>`;
  banner.hidden = false;
}

renderCards();
// The switch redraws every text of the page that is not static HTML.
window.addEventListener('cosens:localechange', () => { renderCards(); renderBanner(); });

if (loginError) {
  history.replaceState(null, '', location.pathname);
  const showBanner = (signedIn: boolean): void => { bannerState = { signedIn }; renderBanner(); };
  api.me(false).then(me => { shell.setAccount(me); showBanner(!!me); if (me) void loadRuns(); }, () => showBanner(false));
} else {
  void shell.ready.then(me => { if (me) void loadRuns(); });
}
