import { useMemo, useState, type ReactNode } from 'react';

/** Outils d'affichage des arbres (organisation) : traits de liaison, niveaux colorés, branches repliables. Les nœuds sont donnés dans l'ordre de l'arbre, avec leur profondeur. */
export interface TNode { id: string; depth: number }
export const LEVEL = ['Racine', 'Niveau 1', 'Niveau 2', 'Niveau 3', 'Niveau 4', 'Niveau 5'];
export const levelName = (rel: number) => LEVEL[Math.min(rel, 5)] ?? `Niveau ${rel}`;

export interface TInfo { rel: number; subs: number; more: boolean[] }

/** Pour chaque nœud : niveau relatif au premier niveau de la liste, nombre de sous-branches, et traits verticaux à prolonger (un frère suit-il ?). */
export function analyze(nodes: TNode[]): TInfo[] {
  const base = nodes.length ? Math.min(...nodes.map(n => n.depth)) : 0;
  return nodes.map((n, i) => {
    let j = i + 1, subs = 0;
    for (; j < nodes.length && nodes[j]!.depth > n.depth; j++) subs++;
    const rel = n.depth - base; const more: boolean[] = [];
    for (let d = 1; d <= rel; d++) { let k = j; while (k < nodes.length && nodes[k]!.depth - base > d) k++; more[d] = k < nodes.length && nodes[k]!.depth - base === d; }
    return { rel, subs, more };
  });
}

/** Indices des nœuds visibles : ceux dont aucun ancêtre n'est replié. */
export function visibleIndexes(nodes: TNode[], collapsed: Set<string>): number[] {
  const out: number[] = []; let skip: number | null = null;
  nodes.forEach((n, i) => { if (skip !== null && n.depth > skip) return; skip = null; out.push(i); if (collapsed.has(n.id)) skip = n.depth; });
  return out;
}

/** État replié, conservé pendant la session du navigateur (clé distincte par arbre affiché). */
export function useCollapsed(key: string): [Set<string>, (next: Set<string>) => void] {
  const [s, setS] = useState<Set<string>>(() => { try { return new Set(JSON.parse(sessionStorage.getItem(key) ?? '[]')); } catch { return new Set(); } });
  return [s, (next: Set<string>) => { setS(next); try { sessionStorage.setItem(key, JSON.stringify([...next])); } catch { /* non conservé */ } }];
}

export const useTree = (nodes: TNode[]) => useMemo(() => analyze(nodes), [nodes]);

/** Traits de liaison, bouton de repli et contenu (nom, cases…) d'une branche. */
export function TreeCell({ rel, info, name, open, closed, onToggle, children }: { rel: number; info: TInfo; name: string; open: boolean; closed: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="treerow">
      {Array.from({ length: rel }, (_, k) => k + 1).map(d => <span key={d} className={`guide${d === rel ? ' last' : ''}${info.more[d] ? ' more' : ''}`} aria-hidden />)}
      {info.subs > 0
        ? <button type="button" className="chev" aria-expanded={open} aria-label={`${open ? 'Replier' : 'Déplier'} la branche ${name}`} onClick={onToggle}>{open ? '▾' : '▸'}</button>
        : <span className="chev leaf" aria-hidden>•</span>}
      {children}
    </div>
  );
}

/** Boutons « Tout replier / Tout déplier » (la racine reste dépliée). */
export function CollapseAll({ nodes, infos, collapsed, set }: { nodes: TNode[]; infos: TInfo[]; collapsed: Set<string>; set: (s: Set<string>) => void }) {
  return (
    <>
      <button type="button" onClick={() => set(new Set())} disabled={collapsed.size === 0}>Tout déplier</button>
      <button type="button" onClick={() => set(new Set(nodes.filter((_, i) => infos[i]!.subs > 0 && infos[i]!.rel > 0).map(n => n.id)))}>Tout replier</button>
    </>
  );
}
