// Version navigateur : jetons dans localStorage (moins protégés que le trousseau d'un téléphone : à n'utiliser que pour le test).
import type { Tokens } from '@visites/sync-core';

const K = 'visites.session.v1';
export interface OrgNode { id: string; name: string; path: string }
export interface Session { server: string; userId: string; role?: 'commercial' | 'manager' | 'directeur'; lang?: string; nodes?: OrgNode[]; tokens: Tokens }

export async function loadSession(): Promise<Session | undefined> {
  try { const raw = localStorage.getItem(K); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
}
export async function saveSession(s: Session) { localStorage.setItem(K, JSON.stringify(s)); }
export async function saveTokens(t: Tokens | undefined) {
  const cur = await loadSession(); if (!cur) return;
  if (t) localStorage.setItem(K, JSON.stringify({ ...cur, tokens: t })); else localStorage.removeItem(K);
}
export async function clearSession() { localStorage.removeItem(K); }

// Marque blanche (nom, logo) : conservée à la déconnexion. Non sensible.
export interface Brand { name: string; logoUrl?: string | null }
export async function loadBrand(): Promise<Brand | undefined> {
  try { const v = localStorage.getItem('visites.brand'); return v ? JSON.parse(v) : undefined; } catch { return undefined; }
}
export async function saveBrand(b: Brand) { try { localStorage.setItem('visites.brand', JSON.stringify(b)); } catch { /* non conservée */ } }

export type ThemePref = 'system' | 'light' | 'dark';
export async function loadTheme(): Promise<ThemePref> {
  try { const v = localStorage.getItem('visites.theme'); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}
export async function saveTheme(t: ThemePref) { try { localStorage.setItem('visites.theme', t); } catch { /* stockage bloqué : préférence non conservée */ } }
