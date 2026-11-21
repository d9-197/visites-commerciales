// Configuration du back. Valeurs de départ : toutes sont des propositions (voir docs/API.md §7).
export interface Config {
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  minAppVersion: string;
  syncOverlap: number;     // recouvrement du curseur de lecture, en numéros de changement
  maxFailedLogins: number;
  lockMinutes: number;
  pullDefaultLimit: number;
}

export const DEV_JWT_SECRET = 'dev-secret-a-changer-dev-secret-a-changer';

export const defaultConfig: Config = {
  jwtSecret: process.env.JWT_SECRET ?? DEV_JWT_SECRET,
  accessTtlSeconds: 15 * 60,
  refreshTtlDays: 30,
  minAppVersion: process.env.MIN_APP_VERSION ?? '0.0.0',
  syncOverlap: Number(process.env.SYNC_OVERLAP ?? 50),
  maxFailedLogins: 5,
  lockMinutes: 15,
  pullDefaultLimit: 200,
};
