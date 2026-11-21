import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from './db.js';
import { defaultConfig, type Config } from './config.js';
import { errorHandler, HttpError } from './errors.js';
import { mobileRouter } from './routes/mobile.js';
import { crmRouter } from './routes/crm.js';
import { adminRouter } from './routes/admin.js';
import type { AiServices } from './ai/index.js';
import type { MailService } from './mail/index.js';
import { DEFAULT_BRAND_NAME, type Brand } from './brand.js';

/** Normalise BASE_PATH (« visit », « /visit/ » -> « /visit ») ; vide pour une application à la racine. Refuse les caractères inattendus. */
export function normalizeBasePath(raw?: string): string {
  const p = (raw ?? '').trim().replace(/\/+$/, '');
  if (!p) return '';
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  if (!/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(withSlash) || withSlash.split('/').some(seg => seg === '.' || seg === '..')) throw new Error(`BASE_PATH invalide : ${raw}`);
  return withSlash;
}

/**
 * Page d'accueil de l'application web. Les ressources sont référencées par des chemins absolus (/_expo/…) : sous un sous-chemin
 * (https://exemple.fr/visit), il faut les préfixer, sinon le navigateur les cherche à la racine du domaine (écran blanc).
 * Le préfixe est aussi transmis à l'application (window.__BASE_PATH__) pour qu'elle appelle l'API au bon endroit.
 */
export function renderIndex(html: string, basePath: string, brand?: Brand): string {
  let out = html;
  if (brand && brand.name !== DEFAULT_BRAND_NAME) out = out.replace(/<title>[^<]*<\/title>/, `<title>${brand.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}</title>`);
  if (brand?.logo) out = out.replace('</head>', `<link rel="icon" href="/api/mobile/v1/brand/logo?v=${brand.logo.version}"></head>`);
  if (!basePath) return out;
  return out
    .replace(/(src|href)="\/(?!\/)/g, `$1="${basePath}/`)
    .replace('</head>', `<script>window.__BASE_PATH__=${JSON.stringify(basePath)};</script></head>`);
}

export function createApp(pool: Pool, cfg: Config = defaultConfig, opts: { webDir?: string; ai?: AiServices; mail?: MailService; brand?: Brand; basePath?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const basePath = normalizeBasePath(opts.basePath);

  const routes = express.Router();
  routes.use(express.json({ limit: '5mb' }));
  routes.use('/api/mobile/v1', mobileRouter(pool, cfg, opts.ai, opts.mail, opts.brand));
  routes.use('/api/crm/v1', crmRouter(pool, cfg));
  routes.use('/api/admin/v1', adminRouter(pool, cfg));
  // Application web (même origine que l'API : pas de CORS). Les routes /api/* inconnues restent en 404 JSON.
  if (opts.webDir && existsSync(join(opts.webDir, 'index.html'))) {
    const index = renderIndex(readFileSync(join(opts.webDir, 'index.html'), 'utf8'), basePath, opts.brand);
    const sendIndex = (_req: express.Request, res: express.Response) => { res.set('Cache-Control', 'no-cache').type('html').send(index); };
    routes.use(express.static(opts.webDir, { index: false, maxAge: '1h' }));
    routes.get(/^(?!\/api\/).*/, sendIndex);
  }
  routes.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'Route inconnue')));
  routes.use(errorHandler);

  // Sous un sous-chemin, l'application répond aux deux cas : le proxy conserve le préfixe (/visit/…) ou le retire (/…).
  if (basePath) app.use(basePath, routes);
  app.use('/', routes);
  return app;
}
