import { MemoryStore } from '@visites/sync-core';

/**
 * Version navigateur du stockage local : mêmes données que le stockage mémoire, enregistrées dans localStorage à chaque
 * écriture. Limites : ~5 Mo, non chiffré, effacé si l'utilisateur vide les données du site. Suffisant pour un test.
 */
const KEY = 'visites.store.v1';

class WebStore extends MemoryStore {
  private persist() { try { localStorage.setItem(KEY, this.snapshot()); } catch { /* quota atteint ou stockage bloqué : on continue en mémoire */ } }
  async setMeta(k: string, v: string | undefined) { await super.setMeta(k, v); this.persist(); }
  async upsert(...a: Parameters<MemoryStore['upsert']>) { await super.upsert(...a); this.persist(); }
  async remove(...a: Parameters<MemoryStore['remove']>) { await super.remove(...a); this.persist(); }
  async clearData() { await super.clearData(); this.persist(); }
  async enqueue(...a: Parameters<MemoryStore['enqueue']>) { await super.enqueue(...a); this.persist(); }
  async replaceQueued(...a: Parameters<MemoryStore['replaceQueued']>) { await super.replaceQueued(...a); this.persist(); }
  async removePending(...a: Parameters<MemoryStore['removePending']>) { await super.removePending(...a); this.persist(); }
  async wipe() { await this.clearData(); for (const o of await this.pending(100000)) await this.removePending(o.id); await this.setMeta('cursor', undefined); try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
}

export async function openStore(): Promise<WebStore> {
  const s = new WebStore();
  try { const raw = localStorage.getItem(KEY); if (raw) s.restore(raw); } catch { /* instantané illisible : on repart de zéro */ }
  return s;
}
