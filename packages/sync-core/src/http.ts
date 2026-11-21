import type { Operation, OperationResult, PullResponse } from './types';
import { ApiError, NetworkError, type Transport } from './engine';

export interface AiProposalResponse {
  id: string; report_id: string; source_text: string; provider: string; model: string;
  proposal: {
    fields: { summary: string; needs: string; objections: string; competitors: string; decisions: string; next_step: string };
    actions: { title: string; due_date: string | null; due_date_certain: boolean }[];
  };
  warnings: string[];
}

export interface Tokens { access_token: string; refresh_token: string; device_id: string }
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ status: number; text(): Promise<string> }>;

/** Client HTTP de l'API mobile : renouvelle le jeton d'accès une fois en cas de 401 et signale les coupures réseau. */
export class ApiClient implements Transport {
  constructor(
    private baseUrl: string, private appVersion: string,
    private tokens: Tokens | undefined,
    private onTokens: (t: Tokens | undefined) => void = () => {},
    private doFetch: FetchLike = (u, i) => fetch(u, i as RequestInit),
  ) {}

  private async raw(method: string, path: string, body?: unknown, auth = true) {
    let res;
    try {
      res = await this.doFetch(this.baseUrl + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-app-version': this.appVersion, ...(auth && this.tokens ? { authorization: `Bearer ${this.tokens.access_token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new NetworkError(); }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  private async call(method: string, path: string, body?: unknown) {
    let r = await this.raw(method, path, body);
    if (r.status === 401 && this.tokens) {
      const t = await this.raw('POST', '/auth/refresh', { refresh_token: this.tokens.refresh_token }, false);
      if (t.status !== 200) { this.tokens = undefined; this.onTokens(undefined); throw new ApiError(401, 'session_expired', 'Reconnexion nécessaire'); }
      this.tokens = t.body as Tokens; this.onTokens(this.tokens);
      r = await this.raw(method, path, body);
    }
    if (r.status >= 400) throw new ApiError(r.status, r.body?.code ?? 'error', r.body?.detail);
    return r.body;
  }

  async login(email: string, password: string, platform: 'ios' | 'android' | 'web', deviceId?: string): Promise<Tokens> {
    const r = await this.raw('POST', '/auth/login', { email, password, device: { platform, app_version: this.appVersion, ...(deviceId ? { device_id: deviceId } : {}) } }, false);
    if (r.status !== 200) throw new ApiError(r.status, r.body?.code ?? 'error', r.body?.detail);
    this.tokens = r.body as Tokens; this.onTokens(this.tokens);
    return this.tokens;
  }

  me() { return this.call('GET', '/me'); }

  /** Synthèse par IA des notes d'une visite. Nécessite le réseau ; la proposition n'est enregistrée nulle part côté appareil. */
  aiPropose(reportId: string, sourceText: string, today: string): Promise<AiProposalResponse> {
    return this.call('POST', `/reports/${reportId}/ai-proposals`, { source_text: sourceText, today });
  }
  async push(operations: Operation[]): Promise<OperationResult[]> {
    return (await this.call('POST', '/sync/push', { device_id: this.tokens?.device_id, operations })).results;
  }
  pull(cursor: string | undefined, limit: number): Promise<PullResponse> {
    const q = new URLSearchParams({ limit: String(limit) }); if (cursor) q.set('cursor', cursor);
    return this.call('GET', `/sync/pull?${q}`);
  }
}
