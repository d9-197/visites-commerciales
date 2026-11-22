import { useState } from 'react';
import { api, type R } from '../api';
import type { Me } from '../App';
import { Alert, AuthorState, Badge, BranchSelect, Card, ClientFilter, Empty, Loading, Modal, useLoad } from '../ui';
import { Planning, usePrep } from './Preparation';
import { EmailModal, ReportEditor } from './VisitActions';
import { STATUS, STATUS_TONE, TEMP, fmtDateTime, fmtDate } from '../format';

const PAGE = 50;
/** Vues préétablies : les trois premières (à organiser, en retard, non attribuées) sont des vues de préparation par zones ; les autres sont des listes filtrées. */
const PRESETS: { id: string; label: string; prep?: { late?: boolean; user?: string }; status?: string }[] = [
  { id: 'all', label: 'Toutes' },
  { id: 'prep', label: 'À organiser avec le client', prep: {} },
  { id: 'late', label: 'En retard', prep: { late: true } },
  { id: 'none', label: 'Non attribuées', prep: { user: 'none' } },
  { id: 'cr', label: 'CR à valider', status: 'done' },
  { id: 'validated', label: 'CR validés', status: 'validated' },
];

/** Visites : liste unique (préparation comprise) avec des vues préétablies et des filtres. */
export function Visits({ me, params }: { me: Me; params: URLSearchParams }) {
  const [preset, setPreset] = useState(PRESETS.some(p => p.id === params.get('vue')) ? params.get('vue')! : params.get('user') ? 'all' : 'prep');
  const [open, setOpen] = useState<string | null>(params.get('open'));
  const [version, setVersion] = useState(0);
  const prep = usePrep(me, () => setVersion(v => v + 1));
  const cur = PRESETS.find(p => p.id === preset)!;
  return (
    <>
      <header className="page-head"><div><h1>Visites</h1><p className="muted">Préparer, attribuer et suivre les visites, de l'organisation avec le client jusqu'au compte rendu. Les notes internes ne sont jamais affichées.</p></div>
        <div className="toolbar"><button className="primary" onClick={() => prep.openPlan()}>+ Préparer une visite</button></div></header>
      <div className="tabs" role="tablist">
        {PRESETS.map(p => <button key={p.id} role="tab" aria-selected={preset === p.id} className={preset === p.id ? 'on' : ''} onClick={() => setPreset(p.id)}>{p.label}</button>)}
      </div>
      {cur.prep
        ? <Planning key={cur.id} version={version} fixed={cur.prep.late || cur.prep.user ? cur.prep : undefined} onEdit={prep.openEdit} onAssign={prep.openAssign} onOpen={setOpen} />
        : <VisitList key={cur.id} version={version} status={cur.status ?? ''} initialUser={params.get('user') ?? ''} onOpen={setOpen} />}
      {open && <Detail id={open} me={me} onClose={() => setOpen(null)} onChanged={() => setVersion(v => v + 1)} />}
      {prep.dialogs}
    </>
  );
}

function VisitList({ version, status: initialStatus, initialUser, onOpen }: { version: number; status: string; initialUser: string; onOpen: (id: string) => void }) {
  const [clients, setClients] = useState<string[]>([]); const [status, setStatus] = useState(initialStatus); const [user, setUser] = useState(initialUser);
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [offset, setOffset] = useState(0); const [node, setNode] = useState('');
  const branches = useLoad(() => api<R>('org/mine'), []);
  const accessNodes: R[] = branches.data?.access ?? [];
  const users = useLoad(() => api<R>('prep/commerciaux'), []);
  const qs = `limit=${PAGE}&offset=${offset}${clients.length ? `&company_ids=${clients.join(',')}` : ''}${status ? `&status=${status}` : ''}${user ? `&user_id=${user}` : ''}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}${node ? `&node_id=${node}` : ''}`;
  const { data, error, loading } = useLoad(() => api<R>(`visits?${qs}`), [qs, version]);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); };
  return (
    <Card>
      <div className="toolbar filters">
        <ClientFilter value={clients} onChange={reset(setClients)} />
        <select aria-label="Statut" value={status} onChange={e => reset(setStatus)(e.target.value)}><option value="">Tous les statuts</option>{Object.entries(STATUS).filter(([k]) => k !== 'closed').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {(users.data?.users?.length ?? 0) > 1 && <select aria-label="Visiteur" value={user} onChange={e => reset(setUser)(e.target.value)}><option value="">Tous les visiteurs</option><option value="none">Non attribuées</option>{users.data!.users.map((u: R) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
        {accessNodes.length > 1 && <BranchSelect nodes={accessNodes as any} value={node} onChange={reset(setNode)} all="Tous mes départements" label="Département" />}
        <input type="date" aria-label="Du" value={from} onChange={e => reset(setFrom)(e.target.value)} /><input type="date" aria-label="Au" value={to} onChange={e => reset(setTo)(e.target.value)} />
      </div>
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Loading />}
      {data && (data.visits.length === 0 ? <Empty>Aucune visite ne correspond.</Empty> : <>
        <div className="scroll"><table className="clickable"><thead><tr><th>Date</th><th>Client</th><th>Visiteur</th><th>Département</th><th>Statut</th><th>Compte rendu</th><th>Opportunité</th><th>Actions à faire</th></tr></thead><tbody>
          {data.visits.map((v: R) => { const st = v.closed ? 'closed' : v.status; return (
            <tr key={v.id} tabIndex={0} onClick={() => onOpen(v.id)} onKeyDown={e => { if (e.key === 'Enter') onOpen(v.id); }}>
              <td>{fmtDateTime(v.ended_at ?? v.started_at ?? v.planned_start)}</td><td><strong>{v.company}</strong></td><td>{v.author}<AuthorState status={v.author_status} role={v.author_role} /></td><td>{String(v.org_path ?? '').split(' › ').slice(-1)[0]}</td>
              <td><Badge tone={STATUS_TONE[st]}>{STATUS[st]}</Badge></td>
              <td>{v.report_status === 'validated' ? <Badge tone="violet">Validé</Badge> : v.report_status ? <Badge tone="amber">Brouillon</Badge> : <span className="muted">—</span>}</td>
              <td>{v.temperature ? <Badge tone={v.temperature === 'hot' ? 'red' : v.temperature === 'warm' ? 'amber' : 'grey'}>{TEMP[v.temperature]}</Badge> : '—'}</td>
              <td>{v.open_actions || '—'}</td>
            </tr>); })}
        </tbody></table></div>
        <div className="pager"><span className="muted">{offset + 1}–{offset + data.visits.length} sur {data.total}</span>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹ Précédentes</button><button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Suivantes ›</button></div></>)}
    </Card>
  );
}

export function Detail({ id, me, onClose, onChanged }: { id: string; me: Me; onClose: () => void; onChanged?: () => void }) {
  const [tick, setTick] = useState(0);
  const { data, error, loading } = useLoad(() => api<R>(`visits/${id}`), [id, tick]);
  const [email, setEmail] = useState(false); const [editor, setEditor] = useState(false); const [msg, setMsg] = useState<string>();
  const v = data?.visit; const rep = data?.report;
  const todo = data?.actions.filter((a: R) => a.status === 'todo').length ?? 0;
  const st = v ? (v.status === 'validated' && todo === 0 ? 'closed' : v.status) : '';
  return (
    <>
    <Modal wide title={v ? `${v.company} — ${fmtDate(v.ended_at ?? v.started_at ?? v.planned_start)}` : 'Visite'} onClose={onClose} footer={<>
      {v && <button onClick={() => setEmail(true)}>✉ Envoyer par e-mail</button>}
      {v && v.author_id === me.id && !['planned', 'organized', 'cancelled', 'deleted'].includes(v.status) && <button className="primary" onClick={() => setEditor(true)}>{v.status === 'validated' || rep?.status === 'validated' ? 'Compte rendu (rouvrir)' : rep ? 'Finaliser le compte rendu' : 'Saisir le compte rendu'}</button>}
      <button onClick={onClose}>Fermer</button></>}>
      {msg && <Alert kind="ok">{msg}</Alert>}
      {error && <Alert>{error}</Alert>}{loading && !data && <Loading />}
      {data && <div className="fiche">
        <section><h3>Visite</h3>
          <dl className="facts">
            <div><dt>Statut</dt><dd><Badge tone={STATUS_TONE[st]}>{STATUS[st]}</Badge></dd></div>
            <div><dt>Département</dt><dd>{v.org_path}</dd></div>
            <div><dt>Visiteur</dt><dd>{v.author}<AuthorState status={v.author_status} role={v.author_role} />{v.created_by_name && v.created_by_name !== v.author ? <small className="muted"> · planifiée par {v.created_by_name}</small> : null}</dd></div>
            <div><dt>Prévue</dt><dd>{fmtDateTime(v.planned_start)}</dd></div><div><dt>Commencée</dt><dd>{fmtDateTime(v.started_at)}</dd></div><div><dt>Fin du rendez-vous</dt><dd>{fmtDateTime(v.ended_at)}</dd></div>
            <div><dt>Adresse</dt><dd>{v.location_text ?? '—'}</dd></div>
          </dl>
          {v.objective && <p><strong>Objectif :</strong> {v.objective}</p>}
          {v.preparation_notes && <p><strong>Points à aborder :</strong> {v.preparation_notes}</p>}
        </section>
        <section><h3>Actions ({data.actions.length})</h3>
          {data.actions.length === 0 ? <p className="muted">Aucune action.</p> : <ul>{data.actions.map((a: R) => <li key={a.id}>{a.status === 'done' ? '✓ ' : a.status === 'cancelled' ? '✗ ' : '○ '}{a.title} <small className="muted">· {a.owner}{a.due_date ? ` · ${fmtDate(a.due_date)}` : ''}{a.status !== 'todo' ? ` · ${a.status === 'done' ? 'terminée' : 'annulée'}` : ''}</small></li>)}</ul>}
        </section>
        <section className="full"><h3>Compte rendu {rep ? <Badge tone={rep.status === 'validated' ? 'violet' : 'amber'}>{rep.status === 'validated' ? 'Validé' : 'Brouillon'}</Badge> : null}</h3>
          {!rep ? <p className="muted">Pas de compte rendu.</p> : <dl>{([['summary', 'Résumé'], ['needs', 'Besoins'], ['objections', 'Objections'], ['competitors', 'Concurrents'], ['decisions', 'Décisions'], ['next_step', 'Prochaine étape']] as const).filter(([k]) => rep[k]).map(([k, l]) => <div key={k}><dt>{l}</dt><dd>{rep[k]}</dd></div>)}
            {rep.opportunity_temperature && <div><dt>Opportunité</dt><dd>{TEMP[rep.opportunity_temperature]}</dd></div>}</dl>}
        </section>
        <section><h3>Notes durant la visite ({data.notes.length})</h3>
          {data.notes.length === 0 ? <p className="muted">Aucune.</p> : <ul>{data.notes.map((n: R) => <li key={n.id}>{n.body}</li>)}</ul>}
        </section>
        <section><h3>Historique</h3>
          {data.history.length === 0 && data.emails.length === 0 ? <p className="muted">Rien.</p> : <ul>
            {data.history.map((h: R, i: number) => <li key={i}><small className="muted">{fmtDateTime(h.changed_at)} · {h.changed_by_name}</small><br />{({ planned_start: 'Date prévue', location_text: 'Adresse', org_node: 'Département', author: 'Attribution', report_validated: 'Compte rendu validé', report_reopened: 'Compte rendu remis en brouillon', visit_deleted: 'Visite supprimée' } as R)[h.field]}{h.new_value ? ` : ${h.old_value ?? '—'} → ${h.new_value}` : ''}</li>)}
            {data.emails.map((e: R, i: number) => <li key={`e${i}`}><small className="muted">{fmtDateTime(e.created_at)} · {e.sender}</small><br />E-mail {e.status === 'sent' ? 'envoyé' : 'en échec'} à {e.recipients.join(', ')}</li>)}</ul>}
        </section>
      </div>}
    </Modal>
      {email && v && <EmailModal visitId={id} company={v.company} onClose={() => setEmail(false)} onSent={t => { setEmail(false); setMsg(t); setTick(x => x + 1); }} />}
      {editor && <ReportEditor visitId={id} me={me} onClose={() => { setEditor(false); setTick(x => x + 1); }} onChanged={() => { setTick(x => x + 1); onChanged?.(); }} />}
    </>
  );
}
