import { MistralService, mistralConfigFromEnv } from './mistral.js';
import type { AiService } from './types.js';

export * from './types.js';
export { MistralService } from './mistral.js';

/** Service d'IA configuré par l'environnement ; undefined si aucune clé : les routes d'IA répondent alors 503. */
export function aiFromEnv(env: NodeJS.ProcessEnv = process.env): { service: AiService; prices: boolean } | undefined {
  const cfg = mistralConfigFromEnv(env);
  return cfg ? { service: new MistralService(cfg), prices: cfg.priceInEurPerM !== undefined && cfg.priceOutEurPerM !== undefined } : undefined;
}
