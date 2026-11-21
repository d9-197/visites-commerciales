import { MistralService, mistralConfigFromEnv } from './mistral.js';
import { VoxtralService } from './voxtral.js';
import type { AiService, TranscriptionService } from './types.js';

export * from './types.js';
export { MistralService } from './mistral.js';
export { VoxtralService } from './voxtral.js';

export interface AiServices {
  service: AiService;                    // synthèse (texte vers compte rendu)
  transcriber: TranscriptionService;     // transcription vocale (voix vers texte)
  prices: boolean;                       // tarifs de synthèse connus : le plafond mensuel est appliqué
  transcribePrice: number | undefined;   // euros par minute d'audio ; sans tarif, coût enregistré à 0
}

/** Services d'IA configurés par l'environnement ; undefined si aucune clé : les routes d'IA répondent alors 503. */
export function aiFromEnv(env: NodeJS.ProcessEnv = process.env): AiServices | undefined {
  const cfg = mistralConfigFromEnv(env);
  if (!cfg) return undefined;
  return {
    service: new MistralService(cfg), transcriber: new VoxtralService(cfg),
    prices: cfg.priceInEurPerM !== undefined && cfg.priceOutEurPerM !== undefined, transcribePrice: cfg.priceTranscribeEurPerMin,
  };
}
