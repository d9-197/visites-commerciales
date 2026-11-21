import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { defaultConfig, DEV_JWT_SECRET } from './config.js';

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error('JWT_SECRET (32 caractères minimum) est obligatoire en production.');
  process.exit(1);
}
if (defaultConfig.jwtSecret === DEV_JWT_SECRET) console.warn('Attention : secret JWT de développement en usage.');

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/visites');

// Premier démarrage : création du schéma si la base est vide.
const exists = (await pool.query(`SELECT to_regclass('public.app_user') AS t`)).rows[0].t;
if (!exists) {
  await pool.query(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  console.log('Schéma créé.');
}

const webDir = resolve(process.env.WEB_DIR ?? new URL('../../mobile/dist-web', import.meta.url).pathname);
const port = Number(process.env.PORT ?? 3000);
createApp(pool, defaultConfig, { webDir }).listen(port, () => console.log(`API et application web sur http://localhost:${port}`));
