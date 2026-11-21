import { AiError, defaultAiLog, errorSnippet, type AiLog, type TranscribeInput, type TranscribeResult, type TranscriptionService } from './types.js';
import type { MistralConfig } from './mistral.js';

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac' };

/**
 * Transcription avec Voxtral (API Mistral) : POST {base}/v1/audio/transcriptions, formulaire multipart
 * (model, file, language facultatif). Le nom du modèle et les formats audio acceptés sont à vérifier avec une vraie clé.
 * L'audio n'est ni conservé ni journalisé : il traverse le back.
 */
export class VoxtralService implements TranscriptionService {
  readonly provider = 'mistral-voxtral';
  constructor(private cfg: MistralConfig & { transcribeModel: string; transcribeTimeoutMs: number }, private doFetch: typeof fetch = fetch, private log: AiLog = defaultAiLog) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const base = input.mime.split(';')[0]!.trim().toLowerCase();
    const form = new FormData();
    form.set('model', this.cfg.transcribeModel);
    form.set('file', new Blob([new Uint8Array(input.audio)], { type: base }), `dictee.${EXT[base] ?? 'bin'}`);
    if (input.language) form.set('language', input.language);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.transcribeTimeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(`${this.cfg.baseUrl}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${this.cfg.apiKey}` }, body: form, signal: ctl.signal });
    } catch { throw new AiError('upstream', 'Le service de transcription est injoignable.'); }
    finally { clearTimeout(timer); }
    if (!res.ok) {
      this.log('transcription refusee', { status: res.status, model: this.cfg.transcribeModel, format: base, octets: input.audio.length, reponse: await errorSnippet(res) });
      throw new AiError('upstream', `Le service de transcription a répondu avec une erreur (${res.status}).`);
    }

    let body: any;
    try { body = await res.json(); } catch { throw new AiError('invalid_output', 'Réponse du service de transcription illisible.'); }
    if (typeof body?.text !== 'string') {
      this.log('transcription hors format', { model: this.cfg.transcribeModel, champs: Object.keys(body ?? {}) });
      throw new AiError('invalid_output', 'La réponse du service de transcription n\'a pas le format attendu.');
    }
    const u = body.usage ?? {};
    const secs = [u.prompt_audio_seconds, u.audio_seconds, u.duration].find(x => Number.isFinite(x));   // champ de durée : non confirmé par la documentation
    return {
      text: body.text.trim(), language: typeof body.language === 'string' ? body.language : (input.language ?? null),
      provider: this.provider, model: String(body.model ?? this.cfg.transcribeModel), audioSeconds: secs === undefined ? null : Number(secs),
    };
  }
}
