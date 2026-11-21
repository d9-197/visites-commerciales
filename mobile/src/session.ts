import * as SecureStore from 'expo-secure-store';
import type { Tokens } from '@visites/sync-core';

// Les jetons restent dans le trousseau iOS / Keystore Android.
const K = { tokens: 'tokens', server: 'server', user: 'user', role: 'role', lang: 'lang' };

export interface Session { server: string; userId: string; role?: 'commercial' | 'manager' | 'directeur'; lang?: string; tokens: Tokens }

export async function loadSession(): Promise<Session | undefined> {
  const [t, s, u, r, l] = await Promise.all([SecureStore.getItemAsync(K.tokens), SecureStore.getItemAsync(K.server), SecureStore.getItemAsync(K.user), SecureStore.getItemAsync(K.role), SecureStore.getItemAsync(K.lang)]);
  return t && s && u ? { tokens: JSON.parse(t), server: s, userId: u, role: (r as Session['role']) ?? undefined, lang: l ?? undefined } : undefined;
}
export async function saveSession(s: Session) {
  await SecureStore.setItemAsync(K.tokens, JSON.stringify(s.tokens));
  await SecureStore.setItemAsync(K.server, s.server);
  await SecureStore.setItemAsync(K.user, s.userId);
  if (s.role) await SecureStore.setItemAsync(K.role, s.role);
  if (s.lang) await SecureStore.setItemAsync(K.lang, s.lang);
}
export async function saveTokens(t: Tokens | undefined) {
  if (t) await SecureStore.setItemAsync(K.tokens, JSON.stringify(t)); else await SecureStore.deleteItemAsync(K.tokens);
}
export async function clearSession() { for (const k of Object.values(K)) await SecureStore.deleteItemAsync(k); }

// Marque blanche (nom, logo) : conservée à la déconnexion, pour l'écran de connexion hors-ligne. Non sensible.
export interface Brand { name: string; logoUrl?: string | null }
export async function loadBrand(): Promise<Brand | undefined> {
  try { const v = await SecureStore.getItemAsync('brand'); return v ? JSON.parse(v) : undefined; } catch { return undefined; }
}
export async function saveBrand(b: Brand) { try { await SecureStore.setItemAsync('brand', JSON.stringify(b)); } catch { /* non conservée */ } }

// Préférence d'affichage : conservée à la déconnexion (ce n'est pas une donnée métier).
export type ThemePref = 'system' | 'light' | 'dark';
export async function loadTheme(): Promise<ThemePref> {
  const v = await SecureStore.getItemAsync('theme');
  return v === 'light' || v === 'dark' ? v : 'system';
}
export async function saveTheme(t: ThemePref) { await SecureStore.setItemAsync('theme', t); }
