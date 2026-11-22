// Client de l'API : jetons en sessionStorage (fermés avec l'onglet), renouvellement automatique, URL relatives (fonctionne sous un sous-chemin).
export type R = Record<string, any>;
export class ApiError extends Error { constructor(public status: number, public code: string, message: string, public extra?: R) { super(message); } }

const ROOT = new URL('../api/', location.href).href;   // page : …/admin/  ->  API : …/api/
const K = 'vb.tokens';
interface Tokens { access_token: string; refresh_token: string; device_id: string }
let tokens: Tokens | null = (() => { try { return JSON.parse(sessionStorage.getItem(K) ?? 'null'); } catch { return null; } })();
const setTokens = (t: Tokens | null) => { tokens = t; try { if (t) sessionStorage.setItem(K, JSON.stringify(t)); else sessionStorage.removeItem(K); } catch { /* stockage bloqué */ } };
export const hasSession = () => tokens !== null;
export const onLogout = { cb: () => {} };

async function send(path: string, init: { method?: string; body?: unknown } = {}, auth = true): Promise<Response> {
  return fetch(ROOT + path, {
    method: init.method ?? 'GET',
    headers: { 'x-app-version': '1.0.0', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth && tokens ? { authorization: `Bearer ${tokens.access_token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function authed(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  let res = await send(path, init);
  if (res.status === 401 && tokens) {
    const t = await send('mobile/v1/auth/refresh', { method: 'POST', body: { refresh_token: tokens.refresh_token } }, false);
    if (t.status === 200) { setTokens(await t.json()); res = await send(path, init); }
    else { setTokens(null); onLogout.cb(); }
  }
  return res;
}

async function fail(res: Response): Promise<never> {
  let b: R = {}; try { b = await res.json(); } catch { /* corps vide */ }
  throw new ApiError(res.status, b.code ?? 'error', b.detail ?? b.title ?? `Erreur ${res.status}`, b);
}

export async function api<T = R>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try { res = await authed('back/v1/' + path, init); } catch { throw new ApiError(0, 'network', 'Serveur injoignable'); }
  if (!res.ok) await fail(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** API mobile avec le jeton du back (même compte, mêmes règles) : synchronisation, IA, transcription, e-mail. */
export async function mobileApi<T = R>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try { res = await authed('mobile/v1/' + path, init); } catch { throw new ApiError(0, 'network', 'Serveur injoignable'); }
  if (!res.ok) await fail(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}
/** Envoi d'un fichier brut (dictée) à l'API mobile. */
export async function mobileUpload<T = R>(path: string, blob: Blob): Promise<T> {
  const doSend = () => fetch(ROOT + 'mobile/v1/' + path, { method: 'POST', headers: { 'content-type': blob.type || 'application/octet-stream', 'x-app-version': '1.0.0', ...(tokens ? { authorization: `Bearer ${tokens.access_token}` } : {}) }, body: blob });
  let res: Response;
  try { res = await doSend(); } catch { throw new ApiError(0, 'network', 'Serveur injoignable'); }
  if (res.status === 401) { await authed('back/v1/me'); try { res = await doSend(); } catch { throw new ApiError(0, 'network', 'Serveur injoignable'); } }   // renouvelle le jeton puis réessaie
  if (!res.ok) await fail(res);
  return await res.json() as T;
}
export const deviceId = () => tokens?.device_id;

export async function download(path: string, filename: string) {
  const res = await authed('back/v1/' + path);
  if (!res.ok) await fail(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

export async function login(email: string, password: string) {
  const res = await send('mobile/v1/auth/login', { method: 'POST', body: { email, password, device: { platform: 'web', app_version: '1.0.0' } } }, false);
  if (!res.ok) await fail(res);
  setTokens(await res.json());
}
export async function logout() {
  try { await authed('mobile/v1/auth/logout', { method: 'POST' }); } catch { /* hors-ligne */ }
  setTokens(null);
}
export async function brand(): Promise<{ name: string; logo: string | null }> {
  try { const b = await (await send('mobile/v1/brand', {}, false)).json(); return { name: b.name, logo: b.logo_path ? ROOT + 'mobile/v1' + b.logo_path : null }; }
  catch { return { name: 'Visites commerciales', logo: null }; }
}
