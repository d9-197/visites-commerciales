import * as SecureStore from 'expo-secure-store';
import type { Tokens } from '@visites/sync-core';

// Les jetons restent dans le trousseau iOS / Keystore Android.
const K = { tokens: 'tokens', server: 'server', user: 'user' };

export interface Session { server: string; userId: string; tokens: Tokens }

export async function loadSession(): Promise<Session | undefined> {
  const [t, s, u] = await Promise.all([SecureStore.getItemAsync(K.tokens), SecureStore.getItemAsync(K.server), SecureStore.getItemAsync(K.user)]);
  return t && s && u ? { tokens: JSON.parse(t), server: s, userId: u } : undefined;
}
export async function saveSession(s: Session) {
  await SecureStore.setItemAsync(K.tokens, JSON.stringify(s.tokens));
  await SecureStore.setItemAsync(K.server, s.server);
  await SecureStore.setItemAsync(K.user, s.userId);
}
export async function saveTokens(t: Tokens | undefined) {
  if (t) await SecureStore.setItemAsync(K.tokens, JSON.stringify(t)); else await SecureStore.deleteItemAsync(K.tokens);
}
export async function clearSession() { for (const k of Object.values(K)) await SecureStore.deleteItemAsync(k); }

// Préférence d'affichage : conservée à la déconnexion (ce n'est pas une donnée métier).
export type ThemePref = 'system' | 'light' | 'dark';
export async function loadTheme(): Promise<ThemePref> {
  const v = await SecureStore.getItemAsync('theme');
  return v === 'light' || v === 'dark' ? v : 'system';
}
export async function saveTheme(t: ThemePref) { await SecureStore.setItemAsync('theme', t); }
