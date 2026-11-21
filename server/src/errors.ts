import type { Request, Response, NextFunction } from 'express';

export class HttpError extends Error {
  constructor(public status: number, public code: string, public detail?: string, public extra?: Record<string, unknown>) {
    super(detail ?? code);
  }
}

const TITLES: Record<number, string> = {
  400: 'Requête invalide', 401: 'Non authentifié', 402: 'Quota atteint', 403: 'Interdit', 404: 'Introuvable',
  409: 'Conflit', 410: 'Curseur périmé', 413: 'Trop volumineux', 423: 'Compte verrouillé', 426: 'Mise à jour requise',
  429: 'Trop de requêtes', 500: 'Erreur interne',
};

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const kind = (err as any)?.type as string | undefined;
  const known = kind === 'entity.too.large' ? new HttpError(413, 'payload_too_large', 'Contenu trop volumineux')
    : kind === 'entity.parse.failed' ? new HttpError(400, 'validation_failed', 'Corps de requête illisible') : undefined;
  const e = err instanceof HttpError ? err : known ?? new HttpError(500, 'internal_error', 'Erreur interne');
  if (!(err instanceof HttpError) && !known) console.error(err);
  res.status(e.status).type('application/problem+json').json({
    type: 'about:blank', title: TITLES[e.status] ?? 'Erreur', status: e.status, code: e.code, detail: e.detail,
    instance: req.header('x-request-id') ?? undefined, ...(e.extra ?? {}),
  });
}

export const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
