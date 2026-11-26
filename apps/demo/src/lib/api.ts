// Same-origin client for /api/demo. The browser never sees a token: the session lives in an HttpOnly cookie.
import { t } from '../../../../shared/i18n.mjs';
import { createSseParser } from './logic.mjs';

export type GroupId = 'memory' | 'method' | 'bp';
export type Slot = 'A' | 'B';
export type Role = 'bp' | 'proposal';
export type FileRef = { fileKey: string; name: string };
export type MemoryFile = { key: string; name: string; source: 'demo' | 'upload'; kind: 'text' | 'document'; state: 'pending' | 'committed' | 'failed'; jobId: string | null; documentId: string | null; error: string | null; addedAt: number };
export type Project = { slot: Slot; title: string; bp: FileRef | null; proposal: FileRef | null; executionId: string | null; attempt: number; status: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; stage: string | null; progress: number; error: string | null };
export type RecipeView = { recipeId: string; versionId: string; number: number; name: string; description: string; instructions: string; selfTest: number | null; rules: string[] };
/** Where a run writes: a VU created for it ('new'), or one the visitor picked ('existing'). Runs stored before the choice have none. */
export type SpaceKind = 'new' | 'existing';
export type Run = {
  id: string; demo: 'investor'; version: number; vuId: string; vuName: string; space?: SpaceKind; createdAt: number; updatedAt: number;
  memory: { files: MemoryFile[]; stats: { people: number; organizations: number; relations: number } | null; startedAt: number | null; completedAt: number | null };
  method: { projects: Project[]; recipe: RecipeView | null; startedAt: number | null; completedAt: number | null; error: string | null };
  bp: FileRef | null;
  lastAnalysisAt: number | null;
};
export type RunSummary = { id: string; vuId: string; vuName: string; space: SpaceKind; createdAt: number; step: number };
/** A VU the visitor may write to (Owner or write member); demo: an earlier investor run of this account used it. */
export type Space = { vuId: string; name: string; createdAt: number | null; role: 'owner' | 'write'; demo: boolean };
/** readOnly: VUs left out because the visitor may only read them. */
export type SpaceList = { spaces: Space[]; readOnly: number };
/** GET runs/:id answers 200 with the last saved run and this field when Memory, RSI or the model failed during the refresh. */
export type RefreshError = { code: string; message: string; service?: string };
export type RunReply = { run: Run; refreshError?: RefreshError };
export type Source = { title: string; verified: boolean };
export type Expert = { name: string; independent?: boolean; role?: string; why?: string; sources?: (Source | string)[] };
export type Person = { name: string; degree?: string; relation?: string; path?: string; why?: string; sources?: (Source | string)[] };
export type Report = { verdict?: { title?: string; text?: string }; top_question?: { title?: string; text?: string; sources?: (Source | string)[] }; experts?: Expert[]; expert_gap?: string; people?: Person[]; people_gap?: string };
export type Analysis = { at: number; seconds: number; vuId: string; bpName?: string; queries: { query: string; titles: string[] }[]; report: Report };
export type ManifestFile = { name: string; path: string; size: number; slot?: Slot; role?: Role };
export type ManifestGroup = { id: GroupId; files: ManifestFile[] };
export type Manifest = { groups: ManifestGroup[] };
/** memory: what step 1 can take here; documents (PDF and Word) and stats are false when Memory runs through the gateway. */
export type Me = { email: string | null; accountId: string; memory?: { documents: boolean; stats: boolean } };
export type AnalyzeEvent =
  | { type: 'phase'; text: string }
  | { type: 'recall'; query: string }
  | { type: 'recall_done'; query: string; titles: string[] }
  | { type: 'report'; analysis: Analysis }
  | { type: 'error'; message: string; code?: string; service?: string };

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly service: string | null;
  constructor(code: string, message: string, status = 0, service: string | null = null) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.service = service;
  }
}

const API = '/api/demo';
export const ASSET_BASE = '/demo/assets/investor/';
const enc = encodeURIComponent;
let leaving = false;

export function loginUrl(returnTo: string = location.pathname + location.search): string {
  return `${API}/auth/login?return=${enc(returnTo)}`;
}

/** Send the visitor through CoSens login and back to this page (once, even if several calls fail together). */
export function goToLogin(): void {
  if (leaving) return;
  leaving = true;
  location.assign(loginUrl());
}

export const codeOf = (err: unknown): string => String((err as { code?: string } | null)?.code ?? '');
const isAbort = (cause: unknown): boolean => (cause as { name?: string } | null)?.name === 'AbortError';
const networkError = (cause: unknown): ApiError => new ApiError('network_error', String((cause as Error | null)?.message ?? cause ?? ''));
const notAuthenticated = (): ApiError => new ApiError('not_authenticated', '', 401, 'auth');

async function errorFrom(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; service?: string } } | null = null;
  try { body = await res.json(); } catch { body = null; }
  const err = body?.error;
  return new ApiError(err?.code || `http_${res.status}`, err?.message || res.statusText, res.status, err?.service ?? null);
}

type RequestOptions = { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal; loginOn401?: boolean };

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) body = options.form;
  let res: Response;
  try {
    res = await fetch(API + path, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers, body, credentials: 'include', cache: 'no-store', redirect: 'manual', signal: options.signal });
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw networkError(cause);
  }
  if (res.status === 401 || res.type === 'opaqueredirect') {
    if (options.loginOn401 !== false) goToLogin();
    throw notAuthenticated();
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const runPath = (id: string): string => `/investor/runs/${enc(id)}`;

export type DemoFileBody = { group: GroupId; demoPath: string; slot?: Slot; role?: Role };
export type UploadFields = { group: GroupId; slot?: Slot; role?: Role };

export const api = {
  me: (loginOn401 = true) => request<Me>('/me', { loginOn401 }),
  logout: () => request<void>('/auth/logout', { method: 'POST', loginOn401: false }),
  listRuns: () => request<{ runs: RunSummary[] }>('/investor/runs').then(r => r.runs),
  listSpaces: () => request<SpaceList>('/investor/spaces'),
  // Without vuId the server creates a VU named in this zone, so the name matches the times the page shows; with vuId the run writes into that VU.
  createRun: (vuId?: string) => request<{ run: Run }>('/investor/runs', { method: 'POST', json: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(vuId ? { vuId } : {}) } }).then(r => r.run),
  getRun: (id: string) => request<RunReply>(runPath(id)),
  addDemoFile: (id: string, body: DemoFileBody) => request<{ run: Run }>(`${runPath(id)}/files`, { method: 'POST', json: body }).then(r => r.run),
  uploadFile: (id: string, file: File, fields: UploadFields) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('group', fields.group);
    if (fields.slot) form.append('slot', fields.slot);
    if (fields.role) form.append('role', fields.role);
    return request<{ run: Run }>(`${runPath(id)}/files`, { method: 'POST', form }).then(r => r.run);
  },
  startMethod: (id: string) => request<{ run: Run }>(`${runPath(id)}/method`, { method: 'POST', json: {} }).then(r => r.run),
  lastAnalysis: (id: string) => request<{ analysis: Analysis }>(`${runPath(id)}/analysis`).then(r => r.analysis),
};

/** Step 3: POST .../analyze and stream its events. Resolves with the saved analysis from the final `report` event. */
export async function analyze(id: string, onEvent: (event: AnalyzeEvent) => void, signal?: AbortSignal): Promise<Analysis> {
  let res: Response;
  try {
    res = await fetch(`${API}${runPath(id)}/analyze`, { method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' }, body: '{}', credentials: 'include', cache: 'no-store', redirect: 'manual', signal });
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw networkError(cause);
  }
  if (res.status === 401 || res.type === 'opaqueredirect') {
    goToLogin();
    throw notAuthenticated();
  }
  if (!res.ok) throw await errorFrom(res);
  if (!res.body || !(res.headers.get('Content-Type') ?? '').includes('text/event-stream')) throw new ApiError('bad_event', t('api.no_stream'), res.status);
  const parser = createSseParser();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const out: { analysis: Analysis | null } = { analysis: null };
  const handle = (events: AnalyzeEvent[]): void => {
    for (const event of events) {
      if (event.type === 'error') throw new ApiError(event.code || 'analysis_failed', event.message || '', 0, event.service ?? null);
      onEvent(event);
      if (event.type === 'report') out.analysis = event.analysis;
    }
  };
  try {
    while (!out.analysis) {
      const { done, value } = await reader.read();
      if (done) break;
      handle(parser.push(decoder.decode(value, { stream: true })));
    }
    if (!out.analysis) {
      handle(parser.push(decoder.decode()));
      handle(parser.end());
    }
  } catch (cause) {
    if (isAbort(cause) || cause instanceof ApiError) throw cause;
    throw new ApiError('stream_broken', t('code.stream_broken'));
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (!out.analysis) throw new ApiError('stream_broken', t('code.stream_broken'));
  return out.analysis;
}

export const assetUrl = (path: string): string => ASSET_BASE + path.split('/').map(enc).join('/');

async function fetchAsset(path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(assetUrl(path), { credentials: 'include', cache: 'no-store', redirect: 'manual' });
  } catch (cause) {
    throw networkError(cause);
  }
  if (res.status === 401 || res.type === 'opaqueredirect') {
    goToLogin();
    throw notAuthenticated();
  }
  if (!res.ok) throw new ApiError('asset_missing', `${path}: HTTP ${res.status}`, res.status);
  return res;
}

export async function loadManifest(): Promise<Manifest> {
  return (await (await fetchAsset('manifest.json')).json()) as Manifest;
}

export async function loadDemoText(path: string): Promise<string> {
  return (await fetchAsset(path)).text();
}
