import { useMemo, useState } from 'react';
import { api, type R } from '../api';
import { Alert, Badge, Card, Empty, Field, Loading, Modal, Tip, useLoad, errMsg } from '../ui';
import { ROLE } from '../format';

type Dlg = { kind: 'add'; parent: R } | { kind: 'rename'; node: R } | { kind: 'move'; node: R } | null;

/** Organisation arborescente (administrateurs) : branches, sous-branches et leurs membres. Les droits d'accès aux données en découlent. */
const KEY = 'vb.org.collapsed';
const loadCollapsed = (): Set<string> => { try { return new Set(JSON.parse(sessionStorage.getItem(KEY) ?? '[]')); } catch { return new Set(); } };
const LEVEL = ['Racine', 'Niveau 1', 'Niveau 2', 'Niveau 3', 'Niveau 4', 'Niveau 5'];

export function Organisation() {
  const { data, error, loading, reload } = useLoad(() => api<R>('org'), []);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const setC = (next: Set<string>) => { setCollapsed(next); try { sessionStorage.setItem(KEY, JSON.stringify([...next])); } catch { /* non conservé */ } };
  const [dlg, setDlg] = useState<Dlg>(null); const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const nodes: R[] = data?.nodes ?? [];
  // Pour chaque branche : sous-branches (toutes) et totaux de son sous-arbre ; les branches sont dans l'ordre de l'arbre.
  const info = useMemo(() => nodes.map((n, i) => {
    let j = i + 1, subs = 0, members = n.members.length, visits = n.visits_count;
    for (; j < nodes.length && nodes[j].depth > n.depth; j++) { subs++; members += nodes[j].members.length; visits += nodes[j].visits_count; }
    // pour chaque niveau d'ancêtre : y a-t-il encore un frère après ce nœud (trait vertical à continuer) ?
    const more: boolean[] = [];
    for (let d = 1; d <= n.depth; d++) { let k = j; while (k < nodes.length && nodes[k].depth > d) k++; more[d] = k < nodes.length && nodes[k].depth === d; }
    return { subs, members, visits, more };
  }), [data]);
  const visible = (() => {
    const out: number[] = []; let skip: number | null = null;
    nodes.forEach((n, i) => { if (skip !== null && n.depth > skip) return; skip = null; out.push(i); if (collapsed.has(n.id)) skip = n.depth; });
    return out;
  })();
  const parents = nodes.filter((_, i) => info[i]!.subs > 0);
  const toggle = (id: string) => { const n = new Set(collapsed); if (n.has(id)) n.delete(id); else n.add(id); setC(n); };
  const remove = async (n: R) => { setMsg(undefined); try { await api(`org/nodes/${n.id}`, { method: 'DELETE' }); reload(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } };
  const whyNoDelete = (n: R) => n.depth === 0 ? "La racine de l'organisation ne se supprime pas." : n.children_count > 0 ? "Cette branche a des sous-branches : supprimez-les ou déplacez-les d'abord."
    : n.members.length > 0 ? "Des utilisateurs sont affectés à cette branche : affectez-les ailleurs d'abord (rubrique Comptes)." : n.visits_count > 0 ? 'Des visites appartiennent à cette branche : elle ne peut pas être supprimée.' : undefined;
  return (
    <>
      <header className="page-head"><div><h1>Organisation</h1><p className="muted">Arbre des branches. Un utilisateur affecté à une branche voit les données de cette branche et de ses sous-branches (managers et directeurs : consolidées ; commerciaux : les leurs). Déplacer une branche change les droits d'accès.</p></div></header>
      {(error || msg) && <Alert kind={msg?.kind ?? 'error'}>{msg?.text ?? error}</Alert>}
      <Card>
        {loading && !data && <Loading />}
        {data && (nodes.length === 0 ? <Empty>Aucune branche.</Empty> : (
          <>
            <div className="toolbar" style={{ marginBottom: 8 }}>
              <button onClick={() => setC(new Set())} disabled={collapsed.size === 0}>Tout déplier</button>
              <button onClick={() => setC(new Set(parents.filter(n => n.depth > 0).map(n => n.id)))}>Tout replier</button>
              <span className="muted">{nodes.length} branches · {Math.max(...nodes.map(n => n.depth)) + 1} niveaux</span>
            </div>
            <div className="scroll"><table className="tree"><thead><tr><th>Branche</th><th>Niveau</th><th>Membres</th><th>Visites</th><th /></tr></thead><tbody>
            {visible.map(i => { const n = nodes[i]!; const f = info[i]!; const open = f.subs > 0 && !collapsed.has(n.id); const closed = f.subs > 0 && collapsed.has(n.id); return (
              <tr key={n.id} className={`lv lv${Math.min(n.depth, 5)}`}>
                <td className="treecell"><div className="treerow">
                  {Array.from({ length: n.depth }, (_, k) => k + 1).map(d => <span key={d} className={`guide${d === n.depth ? ' last' : ''}${f.more[d] ? ' more' : ''}`} aria-hidden />)}
                  {f.subs > 0
                    ? <button className="chev" aria-expanded={open} aria-label={`${open ? 'Replier' : 'Déplier'} la branche ${n.name}`} onClick={() => toggle(n.id)}>{open ? '▾' : '▸'}</button>
                    : <span className="chev leaf" aria-hidden>•</span>}
                  <strong className="nodename">{n.name}</strong>
                  {closed && <span className="badge grey" title={`${f.subs} sous-branche${f.subs > 1 ? 's' : ''} repliée${f.subs > 1 ? 's' : ''}`}>+{f.subs}</span>}
                </div></td>
                <td><span className={`lvtag lv${Math.min(n.depth, 5)}`}>{LEVEL[Math.min(n.depth, 5)] ?? `Niveau ${n.depth}`}</span></td>
                <td className="badges">{closed
                  ? <span className="muted">{f.members} membre{f.members > 1 ? 's' : ''} <small>(sous-branches comprises)</small></span>
                  : <div>{n.members.length === 0 ? <span className="muted">Aucun</span> : n.members.map((m: R) => <Badge key={m.id} tone={m.role === 'commercial' ? 'grey' : m.role === 'manager' ? 'blue' : 'violet'}>{m.name} · {ROLE[m.role]}</Badge>)}</div>}</td>
                <td>{closed ? <span className="muted">{f.visits} <small>(cumul)</small></span> : n.visits_count}</td>
                <td className="actions">
                  <button onClick={() => setDlg({ kind: 'add', parent: n })}>+ Sous-branche</button>
                  <button onClick={() => setDlg({ kind: 'rename', node: n })}>Renommer</button>
                  {n.depth > 0 && <button onClick={() => setDlg({ kind: 'move', node: n })}>Déplacer</button>}
                  <Tip why={whyNoDelete(n)}><button disabled={!!whyNoDelete(n)} onClick={() => void remove(n)}>Supprimer</button></Tip>
                </td>
              </tr>); })}
          </tbody></table></div></>))}
      </Card>
      <p className="muted">Les utilisateurs se rattachent aux branches depuis la rubrique « Comptes » (un utilisateur peut être dans plusieurs branches, avec le même rôle partout).</p>
      {dlg && <NodeModal dlg={dlg} nodes={nodes} onClose={() => setDlg(null)} onDone={(text) => { setDlg(null); reload(); if (text) setMsg({ kind: 'ok', text }); }} />}
    </>
  );
}

function NodeModal({ dlg, nodes, onClose, onDone }: { dlg: NonNullable<Dlg>; nodes: R[]; onClose: () => void; onDone: (msg?: string) => void }) {
  const node = dlg.kind === 'add' ? null : dlg.node;
  const [name, setName] = useState(dlg.kind === 'rename' ? dlg.node.name : ''); const [parent, setParent] = useState<string>(dlg.kind === 'move' ? dlg.node.parent_id : '');
  const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const targets = dlg.kind === 'move' ? nodes.filter(n => n.path !== dlg.node.path && !n.path.startsWith(`${dlg.node.path} › `)) : [];
  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      if (dlg.kind === 'add') await api('org/nodes', { method: 'POST', body: { name: name.trim(), parent_id: dlg.parent.id } });
      else if (dlg.kind === 'rename') await api(`org/nodes/${node!.id}`, { method: 'PATCH', body: { name: name.trim() } });
      else { const r = await api<R>(`org/nodes/${node!.id}`, { method: 'PATCH', body: { parent_id: parent } }); onDone(`Branche déplacée. ${r.revoked} accès retiré(s) sur les appareils.`); return; }
      onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const why = dlg.kind === 'move' ? (!parent || parent === node!.parent_id ? 'Choisissez une nouvelle branche parente.' : undefined) : !name.trim() ? 'Saisissez un nom.' : dlg.kind === 'rename' && name.trim() === node!.name ? 'Aucune modification à enregistrer.' : undefined;
  const title = dlg.kind === 'add' ? `Nouvelle sous-branche de « ${dlg.parent.name} »` : dlg.kind === 'rename' ? `Renommer « ${node!.name} »` : `Déplacer « ${node!.name} »`;
  return (
    <Modal title={title} onClose={onClose} footer={<><button onClick={onClose}>Annuler</button><Tip why={why}><button className="primary" disabled={!!why || busy} onClick={() => void save()}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></Tip></>}>
      {dlg.kind !== 'move'
        ? <div className="form one"><Field label="Nom de la branche"><input value={name} onChange={e => setName(e.target.value)} maxLength={100} autoFocus /></Field></div>
        : <div className="form one"><Field label="Nouvelle branche parente" hint="La branche et toutes ses sous-branches suivent. Les directeurs et managers des anciennes branches parentes perdent l'accès à ses données ; ceux des nouvelles le gagnent."><select value={parent} onChange={e => setParent(e.target.value)}>
          {targets.map(n => <option key={n.id} value={n.id}>{'  '.repeat(n.depth)}{n.name}</option>)}</select></Field></div>}
      {err && <Alert>{err}</Alert>}
    </Modal>
  );
}
