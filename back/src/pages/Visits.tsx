import { useState } from 'react';
import { api, type R } from '../api';
import type { Me } from '../App';
import { Alert, AuthorState, Badge, BranchSelect, Card, Empty, Loading, Modal, useLoad } from '../ui';
import { STATUS, STATUS_TONE, TEMP, fmtDateTime, fmtDate } from '../format';

const PAGE = 50;
export function Visits({ params }: { me: Me; params: URLSearchParams }) {
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [user, setUser] = useState(params.get('user') ?? '');
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [offset, setOffset] = useState(0); const [node, setNode] = useState('');
  const branches = useLoad(() => api<R>('org/mine'), []);
  const accessNodes: R[] = branches.data?.access ?? [];
  const [open, setOpen] = useState<string | null>(params.get('open'));
  const users = useLoad(() => api<R>('prep/commerciaux'), []);
  const qs = `limit=${PAGE}&offset=${offset}&q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}${user ? `&user_id=${user}` : ''}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}${node ? `&node_id=${node}` : ''}`;
  const { data, error, loading } = useLoad(() => api<R>(`visits?${qs}`), [qs]);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); };
  return (
    <>
      <header className="page-head"><div><h1>Visites</h1><p className="muted">Visites, comptes rendus et actions de votre périmètre. Les notes internes ne sont jamais affichées.</p></div></header>
      <Card>
        <div className="toolbar filters">
          <input type="search" placeholder="Client…" aria-label="Client" value={q} onChange={e => reset(setQ)(e.target.value)} />
          <select aria-label="Statut" value={status} onChange={e => reset(setStatus)(e.target.value)}><option value="">Tous les statuts</option>{Object.entries(STATUS).filter(([k]) => k !== 'closed').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {(users.data?.users?.length ?? 0) > 1 && <select aria-label="Commercial" value={user} onChange={e => reset(setUser)(e.target.value)}><option value="">Tous les commerciaux</option>{users.data!.users.map((u: R) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
          {accessNodes.length > 1 && <BranchSelect nodes={accessNodes as any} value={node} onChange={reset(setNode)} all="Toutes mes branches" label="Branche" />}
          <input type="date" aria-label="Du" value={from} onChange={e => reset(setFrom)(e.target.value)} /><input type="date" aria-label="Au" value={to} onChange={e => reset(setTo)(e.target.value)} />
        </div>
        {error && <Alert>{error}</Alert>}
        {loading && !data && <Loading />}
        {data && (data.visits.length === 0 ? <Empty>Aucune visite ne correspond.</Empty> : <>
          <div className="scroll"><table className="clickable"><thead><tr><th>Date</th><th>Client</th><th>Commercial</th><th>Branche</th><th>Statut</th><th>Compte rendu</th><th>Opportunité</th><th>Actions à faire</th></tr></thead><tbody>
            {data.visits.map((v: R) => { const st = v.closed ? 'closed' : v.status; return (
              <tr key={v.id} tabIndex={0} onClick={() => setOpen(v.id)} onKeyDown={e => { if (e.key === 'Enter') setOpen(v.id); }}>
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
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, loading } = useLoad(() => api<R>(`visits/${id}`), [id]);
  const v = data?.visit; const rep = data?.report;
  const todo = data?.actions.filter((a: R) => a.status === 'todo').length ?? 0;
  const st = v ? (v.status === 'validated' && todo === 0 ? 'closed' : v.status) : '';
  return (
    <Modal wide title={v ? `${v.company} — ${fmtDate(v.ended_at ?? v.started_at ?? v.planned_start)}` : 'Visite'} onClose={onClose} footer={<button onClick={onClose}>Fermer</button>}>
      {error && <Alert>{error}</Alert>}{loading && <Loading />}
      {data && <div className="fiche">
        <section><h3>Visite</h3>
          <dl className="facts">
            <div><dt>Statut</dt><dd><Badge tone={STATUS_TONE[st]}>{STATUS[st]}</Badge></dd></div>
            <div><dt>Branche</dt><dd>{v.org_path}</dd></div>
            <div><dt>Commercial</dt><dd>{v.author}<AuthorState status={v.author_status} role={v.author_role} />{v.created_by_name && v.created_by_name !== v.author ? <small className="muted"> · planifiée par {v.created_by_name}</small> : null}</dd></div>
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
            {data.history.map((h: R, i: number) => <li key={i}><small className="muted">{fmtDateTime(h.changed_at)} · {h.changed_by_name}</small><br />{({ planned_start: 'Date prévue', location_text: 'Adresse', report_validated: 'Compte rendu validé', report_reopened: 'Compte rendu remis en brouillon', visit_deleted: 'Visite supprimée' } as R)[h.field]}{h.new_value ? ` : ${h.old_value ?? '—'} → ${h.new_value}` : ''}</li>)}
            {data.emails.map((e: R, i: number) => <li key={`e${i}`}><small className="muted">{fmtDateTime(e.created_at)} · {e.sender}</small><br />E-mail {e.status === 'sent' ? 'envoyé' : 'en échec'} à {e.recipients.join(', ')}</li>)}</ul>}
        </section>
      </div>}
    </Modal>
  );
}
