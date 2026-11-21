import { resolve } from 'node:path';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { aiFromEnv } from './ai/index.js';
import { defaultConfig, DEV_JWT_SECRET } from './config.js';

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error('JWT_SECRET (32 caractères minimum) est obligatoire en production.');
  process.exit(1);
}
if (defaultConfig.jwtSecret === DEV_JWT_SECRET) console.warn('Attention : secret JWT de développement en usage.');

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/visites');

// Premier démarrage : schéma complet ; base existante : migrations en attente.
const applied = await migrate(pool);
if (applied.length) console.log('Migrations appliquées :', applied.join(', '));

const webDir = resolve(process.env.WEB_DIR ?? new URL('../../mobile/dist-web', import.meta.url).pathname);
const port = Number(process.env.PORT ?? 3000);
const ai = aiFromEnv();
console.log(ai ? 'Synthèse par IA et transcription vocale : activées (Mistral).' : 'Synthèse par IA et transcription vocale : désactivées (MISTRAL_API_KEY absente).');
const basePath = process.env.BASE_PATH ?? '';
createApp(pool, defaultConfig, { webDir, ai, basePath }).listen(port, () => console.log(`API et application web sur http://localhost:${port}${basePath ? ` (sous-chemin ${basePath})` : ''}`));
