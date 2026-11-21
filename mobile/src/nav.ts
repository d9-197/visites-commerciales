import type { Row } from '@visites/sync-core';

/** Adresse postale d'un client sur une ligne ; vide si le CRM n'en fournit pas. */
export function companyAddress(c?: Row | null): string {
  if (!c) return '';
  return [c.address_line, [c.postal_code, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(', ');
}

export type NavEnv = 'ios' | 'android' | 'other';

/** Plateforme déduite du système (application native) ou du navigateur (version web). */
export function detectEnv(os: string, userAgent = ''): NavEnv {
  if (os === 'ios') return 'ios';
  if (os === 'android') return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return 'other';
}

export interface NavOption { id: string; label: string; url: string }

/**
 * Applications d'itinéraire proposées à l'utilisateur quand il touche l'adresse. Les liens https s'ouvrent dans
 * l'application correspondante si elle est installée, sinon dans le navigateur. Sur Android, « Autre application »
 * passe par le sélecteur du système (toutes les applications de cartographie installées).
 */
export function navigationOptions(address: string, env: NavEnv): NavOption[] {
  const q = encodeURIComponent(address.trim());
  const opts: NavOption[] = [];
  if (env !== 'android') opts.push({ id: 'apple', label: 'Plans (Apple)', url: `https://maps.apple.com/?daddr=${q}&dirflg=d` });
  opts.push({ id: 'google', label: 'Google Maps', url: `https://www.google.com/maps/dir/?api=1&destination=${q}` });
  opts.push({ id: 'waze', label: 'Waze', url: `https://waze.com/ul?q=${q}&navigate=yes` });
  if (env === 'android') opts.push({ id: 'system', label: 'Autre application (choix du système)', url: `geo:0,0?q=${q}` });
  return opts;
}
