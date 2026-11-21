import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from './db.js';
import { defaultConfig, type Config } from './config.js';
import { errorHandler, HttpError } from './errors.js';
import { mobileRouter } from './routes/mobile.js';
import { crmRouter } from './routes/crm.js';
import { adminRouter } from './routes/admin.js';
import type { AiServices } from './ai/index.js';

export function createApp(pool: Pool, cfg: Config = defaultConfig, opts: { webDir?: string; ai?: AiServices } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/mobile/v1', mobileRouter(pool, cfg, opts.ai));
  app.use('/api/crm/v1', crmRouter(pool, cfg));
  app.use('/api/admin/v1', adminRouter(pool, cfg));
  // Application web (même origine que l'API : pas de CORS). Les routes /api/* inconnues restent en 404 JSON.
  if (opts.webDir && existsSync(join(opts.webDir, 'index.html'))) {
    app.use(express.static(opts.webDir, { index: 'index.html', maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(opts.webDir!, 'index.html')));
  }
  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'Route inconnue')));
  app.use(errorHandler);
  return app;
}
