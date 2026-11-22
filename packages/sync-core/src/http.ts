import type { Operation, OperationResult, PullResponse } from './types';
import { ApiError, NetworkError, type Transport } from './engine';

export interface EmailOptions {
  configured: boolean;
  recipients: { id: string; name: string; email: string; role: string; kind: 'self' | 'hierarchy' }[];
  parts: { report: boolean; actions: number; notes: number };
}
export interface AiProposalResponse {
  id: string; report_id: string; source_text: string; provider: string; model: string;
  proposal: {
    fields: { summary: string; needs: string; objections: string; competitors: string; decisions: string; next_step: string };
    actions: { title: string; due_date: string | null; due_date_certain: boolean }[];
  };
  warnings: string[];
}

export interface AiBriefResponse {
  visit_id: string; empty: boolean; cached: boolean; model?: string; generated_at?: string;
  brief: { summary: string; where_we_left: string; to_address: string[]; watch_out: string[]; questions: string[] } | null;
  warnings: string[]; sources: { reports: number; actions: number };
}
export interface AiReviewIssue { field: string; severity: 'warning' | 'info'; message: string; source: 'rules' | 'ai' }
export interface AiReviewResponse { report_id: string; issues: AiReviewIssue[]; ai: { status: 'ok' | 'skipped' | 'unavailable' | 'rate_limited' | 'quota' | 'failed'; model?: string } }
export interface AiReviewPayload {
  fields: Record<string, string>; temperature?: string | null; actions: { title: string; due_date?: string | null }[]; no_action?: boolean; notes_text?: string; today?: string;
}

export interface Tokens { access_token: string; refresh_token: string; device_id: string }
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Blob | ArrayBuffer }) =>
  Promise<{ status: number; text(): Promise<string> }>;

/** Client HTTP de l'API mobile : renouvelle le jeton d'accès une fois en cas de 401 et signale les coupures réseau. */
export class ApiClient implements Transport {
  constructor(
    private baseUrl: string, private appVersion: string,
    private tokens: Tokens | undefined,
    private onTokens: (t: Tokens | undefined) => void = () => {},
    private doFetch: FetchLike = (u, i) => fetch(u, i as RequestInit),
  ) {}

  private async raw(method: string, path: string, body?: unknown, auth = true, contentType = 'application/json') {
    let res;
    try {
      res = await this.doFetch(this.baseUrl + path, {
        method,
        headers: { 'content-type': contentType, 'x-app-version': this.appVersion, ...(auth && this.tokens ? { authorization: `Bearer ${this.tokens.access_token}` } : {}) },
        body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : (body as Blob | ArrayBuffer),
      });
    } catch { throw new NetworkError(); }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  private async call(method: string, path: string, body?: unknown, contentType = 'application/json') {
    let r = await this.raw(method, path, body, true, contentType);
    if (r.status === 401 && this.tokens) {
      const t = await this.raw('POST', '/auth/refresh', { refresh_token: this.tokens.refresh_token }, false);
      if (t.status !== 200) { this.tokens = undefined; this.onTokens(undefined); throw new ApiError(401, 'session_expired', 'Reconnexion nécessaire'); }
      this.tokens = t.body as Tokens; this.onTokens(this.tokens);
      r = await this.raw(method, path, body, true, contentType);
    }
    if (r.status >= 400) throw new ApiError(r.status, r.body?.code ?? 'error', r.body?.detail);
    return r.body;
  }

  /** Marque blanche du serveur (nom, logo) : publique, appelée avant la connexion. */
  async brand(): Promise<{ name: string; logo_path: string | null }> {
    const r = await this.raw('GET', '/brand', undefined, false);
    if (r.status !== 200) throw new ApiError(r.status, r.body?.code ?? 'error', r.body?.detail);
    return r.body;
  }

  async login(email: string, password: string, platform: 'ios' | 'android' | 'web', deviceId?: string): Promise<Tokens> {
    const r = await this.raw('POST', '/auth/login', { email, password, device: { platform, app_version: this.appVersion, ...(deviceId ? { device_id: deviceId } : {}) } }, false);
    if (r.status !== 200) throw new ApiError(r.status, r.body?.code ?? 'error', r.body?.detail);
    this.tokens = r.body as Tokens; this.onTokens(this.tokens);
    return this.tokens;
  }

  me() { return this.call('GET', '/me'); }

  /** Transcription d'une dictée (Voxtral) : envoie l'audio brut, renvoie le texte à relire. Nécessite le réseau. */
  transcribe(visitId: string, audio: Blob | ArrayBuffer, mime: string, language?: string, durationS?: number): Promise<{ text: string; language: string | null; duration_s: number | null }> {
    const q = new URLSearchParams(); if (language) q.set('language', language); if (durationS !== undefined) q.set('duration_s', String(Math.round(durationS)));
    return this.call('POST', `/visits/${visitId}/transcriptions?${q}`, audio, mime.split(';')[0]!.trim() === 'video/webm' ? 'audio/webm' : mime);
  }

  /** Destinataires possibles (soi-même, hiérarchie) et contenu disponible pour l'e-mail d'une visite. */
  emailOptions(visitId: string): Promise<EmailOptions> { return this.call('GET', `/visits/${visitId}/email-options`); }
  /** Envoi par e-mail (par le back) ; nécessite le réseau. */
  sendVisitEmail(visitId: string, recipientIds: string[], parts: ('report' | 'actions' | 'notes')[], message?: string): Promise<{ sent_to: string[]; parts: string[] }> {
    return this.call('POST', `/visits/${visitId}/email`, { recipient_ids: recipientIds, parts, ...(message?.trim() ? { message: message.trim() } : {}) });
  }

  /** Synthèse par IA des notes d'une visite. Nécessite le réseau ; la proposition n'est enregistrée nulle part côté appareil. */
  aiPropose(reportId: string, sourceText: string, today: string): Promise<AiProposalResponse> {
    return this.call('POST', `/reports/${reportId}/ai-proposals`, { source_text: sourceText, today });
  }
  /** Brief avant visite (IA) : historique validé du client, objectif, actions ouvertes. Nécessite le réseau. */
  aiBrief(visitId: string, today: string, refresh = false): Promise<AiBriefResponse> {
    return this.call('POST', `/visits/${visitId}/ai-brief`, { today, ...(refresh ? { refresh: true } : {}) });
  }
  /** Contrôle du compte rendu avant validation (règles + IA). Nécessite le réseau ; le compte rendu doit exister sur le serveur. */
  aiReview(reportId: string, payload: AiReviewPayload): Promise<AiReviewResponse> {
    return this.call('POST', `/reports/${reportId}/ai-review`, payload);
  }
  async push(operations: Operation[]): Promise<OperationResult[]> {
    return (await this.call('POST', '/sync/push', { device_id: this.tokens?.device_id, operations })).results;
  }
  pull(cursor: string | undefined, limit: number): Promise<PullResponse> {
    const q = new URLSearchParams({ limit: String(limit) }); if (cursor) q.set('cursor', cursor);
    return this.call('GET', `/sync/pull?${q}`);
  }
}
