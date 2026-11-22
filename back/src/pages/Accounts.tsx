import { useState } from 'react';
import { api, type R } from '../api';
import type { Me } from '../App';
import { Alert, Badge, BranchSelect, Card, Empty, Field, Loading, Modal, Tip, useLoad, errMsg } from '../ui';
import { ROLE, fmtDateTime } from '../format';
import { CollapseAll, TreeCell, levelName, useCollapsed, useTree, visibleIndexes } from '../tree';

export function Accounts({ me }: { me: Me }) {
  const [q, setQ] = useState(''); const [role, setRole] = useState(''); const [status, setStatus] = useState(''); const [dept, setDept] = useState('');
  const { data, error, loading, reload } = useLoad(() => api<R>(`users?q=${encodeURIComponent(q)}`), [q]);
  const org = useLoad(() => api<R>('org/mine'), []);
  const deptNodes: R[] = org.data?.access ?? [];
  const [edit, setEdit] = useState<R | 'new' | null>(null);
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);
  const [msg, setMsg] = useState<string>();
  // Filtres : rôle, statut, département (le département et ses sous-départements) ; la recherche texte (nom, e-mail) est faite par le serveur.
  const sub = (id: string) => { const i = deptNodes.findIndex(n => n.id === id); if (i < 0) return new Set<string>(); const out = new Set([id]); for (let k = i + 1; k < deptNodes.length && deptNodes[k].depth > deptNodes[i].depth; k++) out.add(deptNodes[k].id); return out; };
  const inDept = dept ? sub(dept) : null;
  const all: R[] = data?.users ?? [];
  const users = all.filter(u => (!role || (role === 'admin' ? u.is_admin : u.role === role)) && (!status || u.status === status) && (!inDept || u.nodes.some((n: R) => inDept.has(n.id))));
  const act = async (fn: () => Promise<unknown>) => { setMsg(undefined); try { await fn(); reload(); } catch (e) { setMsg(errMsg(e)); } };
  return (
    <>
      <header className="page-head"><div><h1>Comptes</h1><p className="muted">Utilisateurs, rôles et hiérarchie. Le périmètre de chacun (reporting, visites) découle de la hiérarchie.</p></div>
        <div className="toolbar"><button className="primary" onClick={() => setEdit('new')}>+ Nouveau compte</button></div></header>
      {(error || msg) && <Alert>{error ?? msg}</Alert>}
      <Card>
        <div className="toolbar filters">
          <input type="search" placeholder="Rechercher (nom, e-mail)…" aria-label="Rechercher un compte" value={q} onChange={e => setQ(e.target.value)} />
          <select aria-label="Rôle" value={role} onChange={e => setRole(e.target.value)}><option value="">Tous les rôles</option><option value="commercial">Visiteurs</option><option value="manager">Responsables</option><option value="directeur">Directeurs</option><option value="admin">Administrateurs</option></select>
          <select aria-label="Statut" value={status} onChange={e => setStatus(e.target.value)}><option value="">Tous les statuts</option><option value="active">Actifs</option><option value="disabled">Désactivés</option></select>
          {deptNodes.length > 0 && <BranchSelect nodes={deptNodes as any} value={dept} onChange={setDept} all="Tous les départements" label="Département" />}
          <span className="muted">{users.length} compte{users.length > 1 ? 's' : ''}{users.length !== all.length ? ` sur ${all.length}` : ''}</span>
          {(q || role || status || dept) && <button className="link" onClick={() => { setQ(''); setRole(''); setStatus(''); setDept(''); }}>Réinitialiser</button>}
        </div>
        {loading && !data && <Loading />}
        {data && (users.length === 0 ? <Empty>Aucun compte ne correspond.</Empty> : (
          <div className="scroll"><table><thead><tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>Départements</th><th>Statut</th><th>Dernière connexion</th><th /></tr></thead><tbody>
            {users.map(u => (
              <tr key={u.id} className={u.status === 'disabled' ? 'dim' : ''}>
                <td><strong>{u.display_name}</strong>{u.is_admin && <> <Badge tone="violet">Admin</Badge></>}</td><td>{u.email}</td><td>{ROLE[u.role]}</td><td>{u.nodes.length ? u.nodes.map((n: R) => <div key={n.id} title={n.path}>{n.name}</div>) : <span className="muted">{u.is_admin ? 'Toutes (admin)' : 'Aucune'}</span>}</td>
                <td><Badge tone={u.status === 'active' ? 'green' : 'grey'}>{u.status === 'active' ? 'Actif' : 'Désactivé'}</Badge></td><td>{u.last_login_at ? fmtDateTime(u.last_login_at) : '—'}</td>
                <td className="actions">
                  <button onClick={() => setEdit(u)}>Modifier</button>
                  <button onClick={() => void act(async () => { const r = await api<R>(`users/${u.id}/reset-password`, { method: 'POST', body: {} }); setSecret({ who: u.display_name, password: r.temporary_password }); })}>Mot de passe</button>
                  {u.id !== me.id && <button onClick={() => void act(() => api(`users/${u.id}`, { method: 'PATCH', body: { status: u.status === 'active' ? 'disabled' : 'active' } }))}>{u.status === 'active' ? 'Désactiver' : 'Réactiver'}</button>}
                </td>
              </tr>))}
          </tbody></table></div>))}
      </Card>
      <Settings />
      {edit && <UserModal user={edit === 'new' ? null : edit} users={all} onClose={() => setEdit(null)} onDone={pw => { setEdit(null); reload(); if (pw) setSecret(pw); }} />}
      {secret && <Modal title="Mot de passe temporaire" onClose={() => setSecret(null)} footer={<button className="primary" onClick={() => setSecret(null)}>J'ai noté le mot de passe</button>}>
        <p>Mot de passe de <strong>{secret.who}</strong> :</p><p><code className="secret">{secret.password}</code></p>
        <Alert kind="warn">Il n'est affiché qu'une seule fois et n'est pas conservé. Transmettez-le par un canal sûr ; ses sessions en cours ont été fermées.</Alert></Modal>}
    </>
  );
}

/**
 * Sélecteur de départements d'un compte : arbre (niveaux colorés, traits, départements repliables), cases à cocher, récapitulatif des choix.
 * Cocher un département donne accès à ses données et à celles de ses sous-départements (responsables et directeurs : consolidées).
 */
function BranchPicker({ nodes, value, onChange }: { nodes: R[]; value: string[]; onChange: (v: string[]) => void }) {
  const infos = useTree(nodes as any);
  const [collapsed, setCollapsed] = useCollapsed('vb.picker.collapsed');
  const shown = visibleIndexes(nodes as any, collapsed);
  const sel = new Set(value);
  const toggleNode = (id: string) => onChange(sel.has(id) ? value.filter(x => x !== id) : [...value, id]);
  const toggleFold = (id: string) => { const c = new Set(collapsed); if (c.has(id)) c.delete(id); else c.add(id); setCollapsed(c); };
  // Nombre de départements cochés dans le sous-arbre de chaque nœud (affiché quand il est replié).
  const picked = nodes.map((n, i) => { let c = 0; for (let k = i + 1; k < nodes.length && nodes[k].depth > n.depth; k++) if (sel.has(nodes[k].id)) c++; return c; });
  const chosen = nodes.filter(n => sel.has(n.id));
  return (
    <div className="picker">
      <div className="picked-chips" aria-label="Départements choisis">
        {chosen.length === 0 ? <span className="muted">Aucun département choisi</span> : chosen.map(n => (
          <span key={n.id} className="chip" title={n.path}>{n.path.split(' › ').slice(-2).join(' › ')}<button type="button" aria-label={`Retirer le département ${n.name}`} onClick={() => toggleNode(n.id)}>×</button></span>))}
      </div>
      <div className="toolbar" style={{ margin: '6px 0' }}><CollapseAll nodes={nodes as any} infos={infos} collapsed={collapsed} set={setCollapsed} /><small className="muted">Cocher un département donne accès à ses sous-départements.</small></div>
      <div className="treelist" role="group" aria-label="Départements">
        {shown.map(i => { const n = nodes[i]!; const f = infos[i]!; const closed = f.subs > 0 && collapsed.has(n.id); const on = sel.has(n.id); return (
          <div key={n.id} className={`trow lv lv${Math.min(f.rel, 5)}${on ? ' on' : ''}`}>
            <TreeCell rel={f.rel} info={f} name={n.name} open={f.subs > 0 && !closed} closed={closed} onToggle={() => toggleFold(n.id)}>
              <label className="pick"><input type="checkbox" checked={on} onChange={() => toggleNode(n.id)} /> <span className="nodename">{n.name}</span></label>
              <span className={`lvtag lv${Math.min(f.rel, 5)}`}>{levelName(f.rel)}</span>
              {closed && <span className="badge grey" title="Sous-départements repliés">+{f.subs}{picked[i]! > 0 ? ` · ${picked[i]} coché${picked[i]! > 1 ? 's' : ''}` : ''}</span>}
            </TreeCell>
          </div>); })}
      </div>
    </div>
  );
}

function UserModal({ user, users, onClose, onDone }: { user: R | null; users: R[]; onClose: () => void; onDone: (pw?: { who: string; password: string }) => void }) {
  const [f, setF] = useState({ email: user?.email ?? '', display_name: user?.display_name ?? '', role: user?.role ?? 'commercial', node_ids: (user?.nodes ?? []).map((n: R) => n.id) as string[], is_admin: !!user?.is_admin, dictation_language: user?.dictation_language ?? 'fr', budget: user?.ai_budget_cents === null || user?.ai_budget_cents === undefined ? '' : String(user.ai_budget_cents / 100), password: '' });
  const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF(x => ({ ...x, [k]: v }));
  const branches = useLoad(() => api<R>('org/mine'), []);
  const nodeList: R[] = branches.data?.access ?? [];
  const save = async () => {
    setBusy(true); setErr(undefined);
    const body: R = { display_name: f.display_name.trim(), role: f.role, node_ids: f.node_ids, is_admin: f.is_admin, dictation_language: f.dictation_language, ai_budget_cents: f.budget === '' ? null : Math.round(Number(f.budget.replace(',', '.')) * 100), email: f.email.trim() };
    try {
      if (user) { await api(`users/${user.id}`, { method: 'PATCH', body }); onDone(); }
      else { const r = await api<R>('users', { method: 'POST', body: { ...body, ...(f.password ? { password: f.password } : {}) } }); onDone(r.temporary_password ? { who: f.display_name, password: r.temporary_password } : undefined); }
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const why = !f.display_name.trim() ? 'Renseignez le nom affiché.' : f.node_ids.length === 0 && !f.is_admin ? 'Affectez le compte à au moins un département (ou cochez Administrateur).' : !f.email.includes('@') ? 'Renseignez une adresse e-mail valide.' : f.password && f.password.length < 12 ? 'Le mot de passe doit faire 12 caractères au moins (ou laissez vide pour en générer un).' : f.budget !== '' && !(Number(f.budget.replace(',', '.')) >= 0) ? 'Le plafond IA doit être un nombre positif (ou vide).' : '';
  const valid = !why;
  return (
    <Modal title={user ? 'Modifier le compte' : 'Nouveau compte'} onClose={onClose} footer={<><button onClick={onClose}>Annuler</button><Tip why={why}><button className="primary" disabled={!valid || busy} onClick={() => void save()}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></Tip></>}>
      <div className="form">
        <Field label="Nom affiché"><input value={f.display_name} onChange={e => set('display_name', e.target.value)} autoFocus /></Field>
        <Field label="E-mail"><input type="email" value={f.email} onChange={e => set('email', e.target.value)} /></Field>
        <Field label="Rôle"><select value={f.role} onChange={e => set('role', e.target.value)}><option value="commercial">Visiteur</option><option value="manager">Responsable</option><option value="directeur">Directeur</option></select></Field>
        <div className="field full" role="group" aria-label="Départements de l'organisation">
          <span>Départements de l'organisation</span>
          <BranchPicker nodes={nodeList} value={f.node_ids} onChange={v => set('node_ids', v)} />
          <small>Le rôle est le même dans tous les départements. Un responsable ou directeur voit les données de ses départements et de leurs sous-départements ; un visiteur, les siennes.</small>
        </div>
        <Field label="Langue des comptes rendus" hint="Langue dans laquelle l'IA rédige. La dictée détecte seule la langue parlée."><select value={f.dictation_language} onChange={e => set('dictation_language', e.target.value)}>{[['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['it', 'Italien'], ['de', 'Allemand'], ['nl', 'Néerlandais']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Plafond IA mensuel (€)" hint="Vide : plafond global."><input inputMode="decimal" value={f.budget} onChange={e => set('budget', e.target.value)} /></Field>
        <label className="check" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={f.is_admin} onChange={e => set('is_admin', e.target.checked)} /> Administrateur (accès aux comptes, à l'organisation, à la maquette CRM et à tous les périmètres)</label>
        {!user && <Field full label="Mot de passe (facultatif)" hint="Vide : un mot de passe temporaire est généré et affiché une fois. 12 caractères minimum."><input type="text" autoComplete="off" value={f.password} onChange={e => set('password', e.target.value)} /></Field>}
      </div>
      {err && <Alert>{err}</Alert>}
    </Modal>
  );
}

function Settings() {
  const { data, reload } = useLoad(() => api<R>('settings'), []);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string }>(); const [pending, setPending] = useState<{ mode: 1 | 2; impact: R } | null>(null);
  const change = async (mode: 1 | 2, confirm = false) => {
    try { const r = await api<R>('settings', { method: 'PUT', body: { report_visibility_mode: mode, ...(confirm ? { confirm_impact: true } : {}) } }); setPending(null); setMsg({ kind: 'ok', text: `Mode enregistré. ${r.revoked} accès retiré(s) sur les appareils.` }); reload(); }
    catch (e: any) { if (e.code === 'impact_confirmation_required') setPending({ mode, impact: e.extra }); else setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  if (!data) return null;
  return (
    <Card title="Visibilité des comptes rendus">
      <div className="radios">
        <label><input type="radio" name="mode" checked={data.report_visibility_mode === 2} onChange={() => void change(2)} /> <strong>Auteur et hiérarchie</strong><small>Seul l'auteur de la visite et ses supérieurs voient la visite et son compte rendu.</small></label>
        <label><input type="radio" name="mode" checked={data.report_visibility_mode === 1} onChange={() => void change(1)} /> <strong>Visiteurs du client et hiérarchie</strong><small>Tous les visiteurs affectés au client voient les visites de leurs collègues sur ce client.</small></label>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {pending && <Modal title="Confirmer le changement" onClose={() => setPending(null)} footer={<><button onClick={() => setPending(null)}>Annuler</button><button className="primary" onClick={() => void change(pending.mode, true)}>Confirmer</button></>}>
        <p>Ce changement rend <strong>{pending.impact.visits_becoming_visible}</strong> visite(s) visible(s) pour de nouvelles personnes et en masque <strong>{pending.impact.visits_becoming_hidden}</strong> à d'autres. Les appareils concernés retireront ces données à leur prochaine synchronisation.</p></Modal>}
    </Card>
  );
}
