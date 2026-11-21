// Marque blanche : nom de l'entreprise et logo, configurés par l'environnement (BRAND_NAME, BRAND_LOGO_FILE). Chargés au démarrage.
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_BRAND_NAME = 'Visites commerciales';
export const MAX_LOGO_BYTES = 512 * 1024;
const MIMES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export interface Brand { name: string; logo?: { data: Buffer; mime: string; version: string } }

/** Nom nettoyé : sans retours à la ligne ni caractères de contrôle, 60 caractères au plus ; défaut si vide. */
export function cleanBrandName(raw: string | undefined): string {
  const n = (raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return n || DEFAULT_BRAND_NAME;
}

/**
 * Marque de l'environnement. Un logo absent, trop lourd (> 512 Ko) ou d'un format inattendu (png, jpg, webp, svg) est ignoré avec un avertissement :
 * le nom reste appliqué et l'application démarre.
 */
export function brandFromEnv(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = m => console.warn(m)): Brand {
  const brand: Brand = { name: cleanBrandName(env.BRAND_NAME) };
  const file = env.BRAND_LOGO_FILE?.trim();
  if (!file) return brand;
  const mime = MIMES[extname(file).toLowerCase()];
  if (!mime) { warn(`[marque] BRAND_LOGO_FILE ignoré : format non pris en charge (png, jpg, webp, svg)`); return brand; }
  try {
    const size = statSync(file).size;
    if (size > MAX_LOGO_BYTES) { warn(`[marque] BRAND_LOGO_FILE ignoré : ${size} octets (maximum ${MAX_LOGO_BYTES})`); return brand; }
    const data = readFileSync(file);
    brand.logo = { data, mime, version: createHash('sha256').update(data).digest('hex').slice(0, 12) };
  } catch { warn('[marque] BRAND_LOGO_FILE ignoré : fichier illisible'); }
  return brand;
}
