import { z } from 'zod';
import { buildMessages } from './prompt.js';
import { checkProposal } from './guards.js';
import { AiError, type AiService, type StructureInput, type StructureResult } from './types.js';

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

export class MistralService implements AiService {
  readonly provider = 'mistral';
  constructor(private cfg: MistralConfig, private doFetch: typeof fetch = fetch) {}

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
    if (!res.ok) throw new AiError('upstream', `Le service d'IA a répondu avec une erreur (${res.status}).`);

    let body: any;
    try { body = await res.json(); } catch { throw new AiError('invalid_output', 'Réponse du service d\'IA illisible.'); }
    const content: unknown = body?.choices?.[0]?.message?.content;
    let parsed: z.infer<typeof outputSchema>;
    try { parsed = outputSchema.parse(JSON.parse(String(content ?? ''))); }
    catch { throw new AiError('invalid_output', 'La réponse du service d\'IA n\'a pas le format attendu.'); }

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
}
