import express from 'express';
import type { Pool } from './db.js';
import { defaultConfig, type Config } from './config.js';
import { errorHandler, HttpError } from './errors.js';
import { mobileRouter } from './routes/mobile.js';
import { crmRouter } from './routes/crm.js';
import { adminRouter } from './routes/admin.js';

export function createApp(pool: Pool, cfg: Config = defaultConfig) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/mobile/v1', mobileRouter(pool, cfg));
  app.use('/api/crm/v1', crmRouter(pool, cfg));
  app.use('/api/admin/v1', adminRouter(pool, cfg));
  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'Route inconnue')));
  app.use(errorHandler);
  return app;
}
