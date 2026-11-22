import { useState } from 'react';
import { api, type R } from '../api';
import { Alert, Badge, Card, Empty, Field, Loading, Modal, Tip, useLoad, errMsg } from '../ui';
import { ROLE } from '../format';
import { CollapseAll, TreeCell, levelName, useCollapsed, useTree, visibleIndexes } from '../tree';

type Dlg = { kind: 'reassign'; node: R } | { kind: 'add'; parent: R } | { kind: 'addTop' } | { kind: 'rename'; node: R } | { kind: 'move'; node: R } | null;

/** Organisation arborescente (administrateurs) : branches, sous-branches et leurs membres. Les droits d'accès aux données en découlent. */
type TotalsInfo = { members: number; visits: number };

export function Organisation() {
  const { data, error, loading, reload } = useLoad(() => api<R>('org'), []);
  const [collapsed, setC] = useCollapsed('vb.org.collapsed');
  const [dlg, setDlg] = useState<Dlg>(null); const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const nodes: R[] = data?.nodes ?? [];
  const infos = useTree(nodes as any);
  // Totaux du sous-arbre (affichés quand une branche est repliée).
  const totals: TotalsInfo[] = nodes.map((n, i) => { let m = n.members.length, v = n.visits_count; for (let k = i + 1; k < nodes.length && nodes[k].depth > n.depth; k++) { m += nodes[k].members.length; v += nodes[k].visits_count; } return { members: m, visits: v }; });
  const visible = visibleIndexes(nodes as any, collapsed);
  const toggle = (id: string) => { const n = new Set(collapsed); if (n.has(id)) n.delete(id); else n.add(id); setC(n); };
  const remove = async (n: R) => { setMsg(undefined); try { await api(`org/nodes/${n.id}`, { method: 'DELETE' }); reload(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } };
  const whyNoDelete = (n: R) => n.children_count > 0 ? "Cette branche a des sous-branches : supprimez-les ou déplacez-les d'abord."
    : n.members.length > 0 ? "Des utilisateurs sont affectés à cette branche : affectez-les ailleurs d'abord (rubrique Comptes)." : n.visits_count > 0 ? 'Des visites appartiennent à cette branche : réaffectez-les d\'abord à une autre branche (bouton « Réaffecter les visites »).' : undefined;
  return (
    <>
      <header className="page-head"><div className="toolbar" style={{ justifyContent: 'flex-end', order: 2 }}><button className="primary" onClick={() => setDlg({ kind: 'addTop' })}>+ Branche de premier niveau</button></div><div><h1>Organisation</h1><p className="muted">Arbre des branches. Un utilisateur affecté à une branche voit les données de cette branche et de ses sous-branches (managers et directeurs : consolidées ; commerciaux : les leurs). Déplacer une branche change les droits d'accès.</p></div></header>
      {(error || msg) && <Alert kind={msg?.kind ?? 'error'}>{msg?.text ?? error}</Alert>}
      <Card>
        {loading && !data && <Loading />}
        {data && (nodes.length === 0 ? <Empty>Aucune branche.</Empty> : (
          <>
            <div className="toolbar" style={{ marginBottom: 8 }}>
              <CollapseAll nodes={nodes as any} infos={infos} collapsed={collapsed} set={setC} />
              <span className="muted">{nodes.length} branches · {Math.max(...nodes.map(n => n.depth)) + 1} niveaux</span>
            </div>
            <div className="scroll"><table className="tree"><thead><tr><th>Branche</th><th>Niveau</th><th>Membres</th><th>Visites</th><th /></tr></thead><tbody>
            {visible.map(i => { const n = nodes[i]!; const f = infos[i]!; const t = totals[i]!; const closed = f.subs > 0 && collapsed.has(n.id); return (
              <tr key={n.id} className={`lv lv${Math.min(f.rel, 5)}`}>
                <td className="treecell"><TreeCell rel={f.rel} info={f} name={n.name} open={f.subs > 0 && !closed} closed={closed} onToggle={() => toggle(n.id)}>
                  <strong className="nodename">{n.name}</strong>
                  {closed && <span className="badge grey" title={`${f.subs} sous-branche${f.subs > 1 ? 's' : ''} repliée${f.subs > 1 ? 's' : ''}`}>+{f.subs}</span>}
                </TreeCell></td>
                <td><span className={`lvtag lv${Math.min(f.rel, 5)}`}>{levelName(f.rel)}</span></td>
                <td className="badges">{closed
                  ? <span className="muted">{t.members} membre{t.members > 1 ? 's' : ''} <small>(sous-branches comprises)</small></span>
                  : <div>{n.members.length === 0 ? <span className="muted">Aucun</span> : n.members.map((m: R) => <Badge key={m.id} tone={m.role === 'commercial' ? 'grey' : m.role === 'manager' ? 'blue' : 'violet'}>{m.name} · {ROLE[m.role]}</Badge>)}</div>}</td>
                <td>{closed ? <span className="muted">{t.visits} <small>(cumul)</small></span> : n.visits_count}</td>
                <td className="actions">
                  <button onClick={() => setDlg({ kind: 'add', parent: n })}>+ Sous-branche</button>
                  <button onClick={() => setDlg({ kind: 'rename', node: n })}>Renommer</button>
                  <button onClick={() => setDlg({ kind: 'move', node: n })}>Déplacer</button>
                  {n.visits_count > 0 && <button onClick={() => setDlg({ kind: 'reassign', node: n })}>Réaffecter les visites</button>}
                  <Tip why={whyNoDelete(n)}><button disabled={!!whyNoDelete(n)} onClick={() => void remove(n)}>Supprimer</button></Tip>
                </td>
              </tr>); })}
          </tbody></table></div></>))}
      </Card>
      <p className="muted">Les utilisateurs se rattachent aux branches depuis la rubrique « Comptes » (un utilisateur peut être dans plusieurs branches, avec le même rôle partout).</p>
      {dlg?.kind === 'reassign' && <ReassignModal node={dlg.node} nodes={nodes} onClose={() => setDlg(null)} onDone={text => { setDlg(null); reload(); setMsg({ kind: 'ok', text }); }} />}
      {dlg && dlg.kind !== 'reassign' && <NodeModal dlg={dlg} nodes={nodes} onClose={() => setDlg(null)} onDone={(text) => { setDlg(null); reload(); if (text) setMsg({ kind: 'ok', text }); }} />}
    </>
  );
}

/** Réaffectation des visites d'une branche à une autre (pour la vider avant de la supprimer, ou corriger une erreur). */
function ReassignModal({ node, nodes, onClose, onDone }: { node: R; nodes: R[]; onClose: () => void; onDone: (msg: string) => void }) {
  const authors = useLoad(() => api<R>(`org/nodes/${node.id}/visit-authors`), [node.id]);
  const [target, setTarget] = useState(''); const [addAuthors, setAddAuthors] = useState(false); const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const dest = nodes.find(n => n.id === target);
  const list: R[] = authors.data?.authors ?? [];
  const missing = dest ? list.filter(a => !dest.members.some((m: R) => m.id === a.id)) : [];
  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      const r = await api<R>(`org/nodes/${node.id}/reassign-visits`, { method: 'POST', body: { target_id: target, ...(addAuthors && missing.length ? { add_authors: true } : {}) } });
      onDone(`${r.moved} visite${r.moved > 1 ? 's' : ''} réaffectée${r.moved > 1 ? 's' : ''} à « ${dest!.name} »${r.authors_added ? `, ${r.authors_added} auteur${r.authors_added > 1 ? 's' : ''} affecté${r.authors_added > 1 ? 's' : ''} à cette branche` : ''}. ${r.revoked} accès retiré(s) sur les appareils.`);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const why = !target ? 'Choisissez la branche qui recevra les visites.' : undefined;
  return (
    <Modal title={`Réaffecter les visites de « ${node.name} »`} onClose={onClose} footer={<><button onClick={onClose}>Annuler</button><Tip why={why}><button className="primary" disabled={!!why || busy || list.length === 0} onClick={() => void save()}>{busy ? 'Réaffectation…' : `Réaffecter ${authors.data?.total ?? ''} visite${(authors.data?.total ?? 0) > 1 ? 's' : ''}`}</button></Tip></>}>
      {authors.loading && <Loading />}{authors.error && <Alert>{authors.error}</Alert>}
      {authors.data && <>
        <p><strong>{authors.data.total}</strong> visite{authors.data.total > 1 ? 's' : ''} (supprimées comprises) de : {list.map((a, i) => <span key={a.id}>{i > 0 ? ', ' : ''}{a.name} ({a.visits}){a.status === 'disabled' ? ' — désactivé' : ''}</span>)}.</p>
        <div className="form one"><Field label="Branche qui reçoit les visites"><select value={target} onChange={e => { setTarget(e.target.value); setAddAuthors(false); }}>
          <option value="">Choisir…</option>{nodes.filter(n => n.id !== node.id).map(n => <option key={n.id} value={n.id}>{'\u00A0\u00A0'.repeat(n.depth)}{n.name}</option>)}</select></Field></div>
        <Alert kind="warn">Les directeurs et managers de « {node.name} » perdent l'accès à ces visites, ceux de la branche choisie le gagnent ; les retraits sont transmis aux appareils. Chaque visite garde la trace du changement dans son historique. Les auteurs gardent l'accès à leurs visites.</Alert>
        {dest && missing.length > 0 && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={addAuthors} onChange={e => setAddAuthors(e.target.checked)} /> Affecter aussi à « {dest.name} » les auteurs qui n'en sont pas membres : {missing.map(a => a.name).join(', ')}</label>}
      </>}
      {err && <Alert>{err}</Alert>}
    </Modal>
  );
}

function NodeModal({ dlg, nodes, onClose, onDone }: { dlg: NonNullable<Dlg>; nodes: R[]; onClose: () => void; onDone: (msg?: string) => void }) {
  const node = dlg.kind === 'add' || dlg.kind === 'addTop' ? null : dlg.node;
  const [name, setName] = useState(dlg.kind === 'rename' ? dlg.node.name : ''); const [parent, setParent] = useState<string>(dlg.kind === 'move' ? (dlg.node.parent_id ?? 'top') : '');   // 'top' : premier niveau
  const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const targets = dlg.kind === 'move' ? nodes.filter(n => n.id !== dlg.node.id && !n.path.startsWith(`${dlg.node.path} › `)) : [];
  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      if (dlg.kind === 'add') await api('org/nodes', { method: 'POST', body: { name: name.trim(), parent_id: dlg.parent.id } });
      else if (dlg.kind === 'addTop') await api('org/nodes', { method: 'POST', body: { name: name.trim() } });
      else if (dlg.kind === 'rename') await api(`org/nodes/${node!.id}`, { method: 'PATCH', body: { name: name.trim() } });
      else { const r = await api<R>(`org/nodes/${node!.id}`, { method: 'PATCH', body: { parent_id: parent === 'top' ? null : parent } }); onDone(`Branche déplacée. ${r.revoked} accès retiré(s) sur les appareils.`); return; }
      onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const why = dlg.kind === 'move' ? (!parent || parent === (node!.parent_id ?? 'top') ? 'Choisissez un nouvel emplacement.' : undefined) : !name.trim() ? 'Saisissez un nom.' : dlg.kind === 'rename' && name.trim() === node!.name ? 'Aucune modification à enregistrer.' : undefined;
  const title = dlg.kind === 'addTop' ? 'Nouvelle branche de premier niveau' : dlg.kind === 'add' ? `Nouvelle sous-branche de « ${dlg.parent.name} »` : dlg.kind === 'rename' ? `Renommer « ${node!.name} »` : `Déplacer « ${node!.name} »`;
  return (
    <Modal title={title} onClose={onClose} footer={<><button onClick={onClose}>Annuler</button><Tip why={why}><button className="primary" disabled={!!why || busy} onClick={() => void save()}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></Tip></>}>
      {dlg.kind !== 'move'
        ? <div className="form one"><Field label="Nom de la branche"><input value={name} onChange={e => setName(e.target.value)} maxLength={100} autoFocus /></Field></div>
        : <div className="form one"><Field label="Nouvel emplacement" hint="La branche et toutes ses sous-branches suivent. Les directeurs et managers des anciennes branches parentes perdent l'accès à ses données ; ceux des nouvelles le gagnent."><select value={parent} onChange={e => setParent(e.target.value)}>
          <option value="top">— Premier niveau (sans branche parente) —</option>
          {targets.map(n => <option key={n.id} value={n.id}>{'  '.repeat(n.depth)}{n.name}</option>)}</select></Field></div>}
      {err && <Alert>{err}</Alert>}
    </Modal>
  );
}
