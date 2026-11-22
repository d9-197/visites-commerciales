import { z } from 'zod';
import { buildMessages, buildBriefMessages, buildReviewMessages } from './prompt.js';
import { checkProposal, numbersIn, properNamesIn } from './guards.js';
import { AiError, defaultAiLog, errorSnippet, type AiLog, type AiService, type Brief, type BriefInput, type BriefResult, type ReviewInput, type ReviewIssue, type ReviewResult, type StructureInput, type StructureResult } from './types.js';

export interface MistralConfig {
  apiKey: string;
  baseUrl: string;               // https://api.mistral.ai (traitement dans l'UE par défaut selon la documentation à confirmer)
  model: string;
  timeoutMs: number;
  priceInEurPerM?: number;       // euros par million de jetons ; sans tarif, le coût est enregistré à 0 et le plafond n'est pas appliqué
  priceOutEurPerM?: number;
  transcribeModel: string;       // transcription vocale (Voxtral)
  transcribeTimeoutMs: number;
  priceTranscribeEurPerMin?: number;
}

export function mistralConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MistralConfig | undefined {
  if (!env.MISTRAL_API_KEY) return undefined;
  const num = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    apiKey: env.MISTRAL_API_KEY,
    baseUrl: (env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai').replace(/\/$/, ''),
    model: env.MISTRAL_MODEL ?? 'mistral-small-latest',          // nom à vérifier dans la documentation Mistral au moment du déploiement
    timeoutMs: Number(env.MISTRAL_TIMEOUT_MS ?? 30000),
    priceInEurPerM: num(env.MISTRAL_PRICE_IN_EUR_PER_M), priceOutEurPerM: num(env.MISTRAL_PRICE_OUT_EUR_PER_M),
    transcribeModel: env.MISTRAL_TRANSCRIBE_MODEL ?? 'voxtral-mini-latest',      // l'alias a changé de cible selon les pages de la documentation : à vérifier
    transcribeTimeoutMs: Number(env.MISTRAL_TRANSCRIBE_TIMEOUT_MS ?? 60000),
    priceTranscribeEurPerMin: num(env.MISTRAL_PRICE_TRANSCRIBE_EUR_PER_MIN),
  };
}

const str = z.string().trim().max(2000).catch('');
const dateOrNull = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null);
const outputSchema = z.object({
  fields: z.object({ summary: str, needs: str, objections: str, competitors: str, decisions: str, next_step: str }),
  actions: z.array(z.object({ title: z.string().trim().min(1).max(200), due_date: dateOrNull, relative_date: z.boolean().catch(false) })).max(10).catch([]),
});

const list = z.array(z.string().trim().min(1).max(300)).max(8).catch([]);
const briefSchema = z.object({ summary: str, where_we_left: str, to_address: list, watch_out: list, questions: list });
const reviewSchema = z.object({ issues: z.array(z.object({
  field: z.enum(['summary', 'needs', 'objections', 'competitors', 'decisions', 'next_step', 'actions', 'general']).catch('general'),
  severity: z.enum(['warning', 'info']).catch('info'),
  message: z.string().trim().min(1).max(300),
})).max(8).catch([]) });

export class MistralService implements AiService {
  readonly provider = 'mistral';
  constructor(private cfg: MistralConfig, private doFetch: typeof fetch = fetch, private log: AiLog = defaultAiLog) {}

  async structure(input: StructureInput): Promise<StructureResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({
          model: this.cfg.model, messages: buildMessages(input), response_format: { type: 'json_object' },
          temperature: 0.1,       // peu de créativité : on veut de la fidélité
        }),
        signal: ctl.signal,
      });
    } catch { throw new AiError('upstream', 'Le service d\'IA est injoignable.'); }
    finally { clearTimeout(timer); }
    if (!res.ok) {
      this.log('synthese refusee', { status: res.status, model: this.cfg.model, reponse: await errorSnippet(res) });
      throw new AiError('upstream', `Le service d'IA a répondu avec une erreur (${res.status}).`);
    }

    let body: any;
    try { body = await res.json(); } catch { throw new AiError('invalid_output', 'Réponse du service d\'IA illisible.'); }
    const content: unknown = body?.choices?.[0]?.message?.content;
    let parsed: z.infer<typeof outputSchema>;
    try { parsed = outputSchema.parse(JSON.parse(String(content ?? ''))); }
    catch { this.log('synthese hors format', { model: this.cfg.model, longueur: String(content ?? '').length }); throw new AiError('invalid_output', 'La réponse du service d\'IA n\'a pas le format attendu.'); }

    const proposal = {
      fields: parsed.fields,
      actions: parsed.actions.map(a => ({ title: a.title, due_date: a.due_date, due_date_certain: a.due_date !== null && !a.relative_date })),
    };
    const tokensIn = Number.isFinite(body?.usage?.prompt_tokens) ? Number(body.usage.prompt_tokens) : null;
    const tokensOut = Number.isFinite(body?.usage?.completion_tokens) ? Number(body.usage.completion_tokens) : null;
    const costCents = ((tokensIn ?? 0) * (this.cfg.priceInEurPerM ?? 0) + (tokensOut ?? 0) * (this.cfg.priceOutEurPerM ?? 0)) / 1e6 * 100;
    return {
      proposal, warnings: checkProposal(proposal, input.sourceText, input.today),
      provider: this.provider, model: String(body?.model ?? this.cfg.model), usage: { tokensIn, tokensOut }, costCents,
    };
  }

  /** Appel de complétion JSON commun au brief et au contrôle : mêmes délais, mêmes erreurs neutres, jamais de contenu journalisé. */
  private async completeJson(messages: { role: string; content: string }[], label: string): Promise<{ content: unknown; model: string; usage: { tokensIn: number | null; tokensOut: number | null }; costCents: number }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({ model: this.cfg.model, messages, response_format: { type: 'json_object' }, temperature: 0.2 }), signal: ctl.signal,
      });
    } catch { throw new AiError('upstream', 'Le service d\'IA est injoignable.'); }
    finally { clearTimeout(timer); }
    if (!res.ok) { this.log(`${label} refuse`, { status: res.status, model: this.cfg.model, reponse: await errorSnippet(res) }); throw new AiError('upstream', `Le service d'IA a répondu avec une erreur (${res.status}).`); }
    let body: any;
    try { body = await res.json(); } catch { throw new AiError('invalid_output', 'Réponse du service d\'IA illisible.'); }
    const tokensIn = Number.isFinite(body?.usage?.prompt_tokens) ? Number(body.usage.prompt_tokens) : null;
    const tokensOut = Number.isFinite(body?.usage?.completion_tokens) ? Number(body.usage.completion_tokens) : null;
    const costCents = ((tokensIn ?? 0) * (this.cfg.priceInEurPerM ?? 0) + (tokensOut ?? 0) * (this.cfg.priceOutEurPerM ?? 0)) / 1e6 * 100;
    return { content: body?.choices?.[0]?.message?.content, model: String(body?.model ?? this.cfg.model), usage: { tokensIn, tokensOut }, costCents };
  }

  async brief(input: BriefInput): Promise<BriefResult> {
    const r = await this.completeJson(buildBriefMessages(input), 'brief');
    let brief: Brief;
    try { brief = briefSchema.parse(JSON.parse(String(r.content ?? ''))); }
    catch { this.log('brief hors format', { model: this.cfg.model, longueur: String(r.content ?? '').length }); throw new AiError('invalid_output', 'La réponse du service d\'IA n\'a pas le format attendu.'); }
    // Contrôles : nombres et noms du brief absents de l'historique fourni (le modèle a pu les inventer).
    const source = JSON.stringify([input.objective, input.preparationNotes, input.reports, input.openActions]);
    const srcNumbers = numbersIn(source); const srcText = source.toLocaleLowerCase('fr');
    const warnings: string[] = []; const seen = new Set<string>();
    for (const t of [brief.summary, brief.where_we_left, ...brief.to_address, ...brief.watch_out, ...brief.questions]) {
      for (const n of numbersIn(t)) if (!srcNumbers.has(n) && !seen.has(n)) { seen.add(n); warnings.push(`Nombre absent de l'historique : ${n}.`); }
      for (const w of properNamesIn(t)) if (!srcText.includes(w.toLocaleLowerCase('fr')) && !seen.has(w)) { seen.add(w); warnings.push(`Nom absent de l'historique : ${w}.`); }
    }
    return { brief, warnings, provider: this.provider, model: r.model, usage: r.usage, costCents: r.costCents };
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    const r = await this.completeJson(buildReviewMessages(input), 'controle');
    let parsed: z.infer<typeof reviewSchema>;
    try { parsed = reviewSchema.parse(JSON.parse(String(r.content ?? ''))); }
    catch { this.log('controle hors format', { model: this.cfg.model, longueur: String(r.content ?? '').length }); throw new AiError('invalid_output', 'La réponse du service d\'IA n\'a pas le format attendu.'); }
    const issues: ReviewIssue[] = parsed.issues.map(i => ({ ...i, source: 'ai' as const }));
    return { issues, provider: this.provider, model: r.model, usage: r.usage, costCents: r.costCents };
  }
}
