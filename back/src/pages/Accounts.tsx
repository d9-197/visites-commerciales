import { useState } from 'react';
import { api, type R } from '../api';
import type { Me } from '../App';
import { Alert, Badge, Card, Empty, Field, Loading, Modal, Tip, useLoad, errMsg } from '../ui';
import { ROLE, fmtDateTime } from '../format';

export function Accounts({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useLoad(() => api<R>(`users?q=${encodeURIComponent(q)}`), [q]);
  const [edit, setEdit] = useState<R | 'new' | null>(null);
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);
  const [msg, setMsg] = useState<string>();
  const users: R[] = data?.users ?? [];
  const act = async (fn: () => Promise<unknown>) => { setMsg(undefined); try { await fn(); reload(); } catch (e) { setMsg(errMsg(e)); } };
  return (
    <>
      <header className="page-head"><div><h1>Comptes</h1><p className="muted">Utilisateurs, rôles et hiérarchie. Le périmètre de chacun (reporting, visites) découle de la hiérarchie.</p></div>
        <div className="toolbar"><input type="search" placeholder="Rechercher…" aria-label="Rechercher un compte" value={q} onChange={e => setQ(e.target.value)} /><button className="primary" onClick={() => setEdit('new')}>+ Nouveau compte</button></div></header>
      {(error || msg) && <Alert>{error ?? msg}</Alert>}
      <Card>
        {loading && !data && <Loading />}
        {data && (users.length === 0 ? <Empty>Aucun compte.</Empty> : (
          <div className="scroll"><table><thead><tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>Supérieur</th><th>Statut</th><th>Dernière connexion</th><th /></tr></thead><tbody>
            {users.map(u => (
              <tr key={u.id} className={u.status === 'disabled' ? 'dim' : ''}>
                <td><strong>{u.display_name}</strong>{u.is_admin && <> <Badge tone="violet">Admin</Badge></>}</td><td>{u.email}</td><td>{ROLE[u.role]}</td><td>{u.manager_name ?? '—'}</td>
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
      {edit && <UserModal user={edit === 'new' ? null : edit} users={users} onClose={() => setEdit(null)} onDone={pw => { setEdit(null); reload(); if (pw) setSecret(pw); }} />}
      {secret && <Modal title="Mot de passe temporaire" onClose={() => setSecret(null)} footer={<button className="primary" onClick={() => setSecret(null)}>J'ai noté le mot de passe</button>}>
        <p>Mot de passe de <strong>{secret.who}</strong> :</p><p><code className="secret">{secret.password}</code></p>
        <Alert kind="warn">Il n'est affiché qu'une seule fois et n'est pas conservé. Transmettez-le par un canal sûr ; ses sessions en cours ont été fermées.</Alert></Modal>}
    </>
  );
}

function UserModal({ user, users, onClose, onDone }: { user: R | null; users: R[]; onClose: () => void; onDone: (pw?: { who: string; password: string }) => void }) {
  const [f, setF] = useState({ email: user?.email ?? '', display_name: user?.display_name ?? '', role: user?.role ?? 'commercial', manager_id: user?.manager_id ?? '', is_admin: !!user?.is_admin, dictation_language: user?.dictation_language ?? 'fr', budget: user?.ai_budget_cents === null || user?.ai_budget_cents === undefined ? '' : String(user.ai_budget_cents / 100), password: '' });
  const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF(x => ({ ...x, [k]: v }));
  const managers = users.filter(u => u.role !== 'commercial' && u.status === 'active' && u.id !== user?.id);
  const save = async () => {
    setBusy(true); setErr(undefined);
    const body: R = { display_name: f.display_name.trim(), role: f.role, manager_id: f.manager_id || null, is_admin: f.is_admin, dictation_language: f.dictation_language, ai_budget_cents: f.budget === '' ? null : Math.round(Number(f.budget.replace(',', '.')) * 100), email: f.email.trim() };
    try {
      if (user) { await api(`users/${user.id}`, { method: 'PATCH', body }); onDone(); }
      else { const r = await api<R>('users', { method: 'POST', body: { ...body, ...(f.password ? { password: f.password } : {}) } }); onDone(r.temporary_password ? { who: f.display_name, password: r.temporary_password } : undefined); }
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const why = !f.display_name.trim() ? 'Renseignez le nom affiché.' : !f.email.includes('@') ? 'Renseignez une adresse e-mail valide.' : f.password && f.password.length < 12 ? 'Le mot de passe doit faire 12 caractères au moins (ou laissez vide pour en générer un).' : f.budget !== '' && !(Number(f.budget.replace(',', '.')) >= 0) ? 'Le plafond IA doit être un nombre positif (ou vide).' : '';
  const valid = !why;
  return (
    <Modal title={user ? 'Modifier le compte' : 'Nouveau compte'} onClose={onClose} footer={<><button onClick={onClose}>Annuler</button><Tip why={why}><button className="primary" disabled={!valid || busy} onClick={() => void save()}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></Tip></>}>
      <div className="form">
        <Field label="Nom affiché"><input value={f.display_name} onChange={e => set('display_name', e.target.value)} autoFocus /></Field>
        <Field label="E-mail"><input type="email" value={f.email} onChange={e => set('email', e.target.value)} /></Field>
        <Field label="Rôle"><select value={f.role} onChange={e => set('role', e.target.value)}><option value="commercial">Commercial</option><option value="manager">Manager</option><option value="directeur">Directeur</option></select></Field>
        <Field label="Supérieur hiérarchique"><select value={f.manager_id} onChange={e => set('manager_id', e.target.value)}><option value="">Aucun</option>{managers.map(m => <option key={m.id} value={m.id}>{m.display_name} ({ROLE[m.role]})</option>)}</select></Field>
        <Field label="Langue des comptes rendus" hint="Langue dans laquelle l'IA rédige. La dictée détecte seule la langue parlée."><select value={f.dictation_language} onChange={e => set('dictation_language', e.target.value)}>{[['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['it', 'Italien'], ['de', 'Allemand'], ['nl', 'Néerlandais']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Plafond IA mensuel (€)" hint="Vide : plafond global."><input inputMode="decimal" value={f.budget} onChange={e => set('budget', e.target.value)} /></Field>
        <Field full label=""><span className="check"><input type="checkbox" checked={f.is_admin} onChange={e => set('is_admin', e.target.checked)} /> Administrateur (accès aux comptes, à la maquette CRM et à tous les périmètres)</span></Field>
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
        <label><input type="radio" name="mode" checked={data.report_visibility_mode === 1} onChange={() => void change(1)} /> <strong>Commerciaux du client et hiérarchie</strong><small>Tous les commerciaux affectés au client voient les visites de leurs collègues sur ce client.</small></label>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {pending && <Modal title="Confirmer le changement" onClose={() => setPending(null)} footer={<><button onClick={() => setPending(null)}>Annuler</button><button className="primary" onClick={() => void change(pending.mode, true)}>Confirmer</button></>}>
        <p>Ce changement rend <strong>{pending.impact.visits_becoming_visible}</strong> visite(s) visible(s) pour de nouvelles personnes et en masque <strong>{pending.impact.visits_becoming_hidden}</strong> à d'autres. Les appareils concernés retireront ces données à leur prochaine synchronisation.</p></Modal>}
    </Card>
  );
}
