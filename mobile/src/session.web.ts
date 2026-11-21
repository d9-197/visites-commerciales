// Version navigateur : jetons dans localStorage (moins protégés que le trousseau d'un téléphone : à n'utiliser que pour le test).
import type { Tokens } from '@visites/sync-core';

const K = 'visites.session.v1';
export interface Session { server: string; userId: string; tokens: Tokens }

export async function loadSession(): Promise<Session | undefined> {
  try { const raw = localStorage.getItem(K); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
}
export async function saveSession(s: Session) { localStorage.setItem(K, JSON.stringify(s)); }
export async function saveTokens(t: Tokens | undefined) {
  const cur = await loadSession(); if (!cur) return;
  if (t) localStorage.setItem(K, JSON.stringify({ ...cur, tokens: t })); else localStorage.removeItem(K);
}
export async function clearSession() { localStorage.removeItem(K); }
