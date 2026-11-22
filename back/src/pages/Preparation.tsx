import { useEffect, useState } from 'react';
import { api, type R } from '../api';
import type { Me } from '../App';
import { Alert, Badge, Card, Empty, Field, Loading, Modal, Tip, useLoad, errMsg } from '../ui';
import { REASON, STATUS, STATUS_TONE, TEMP, daysAgo, fmtDate, fmtDateTime, isoToLocal, localToIso } from '../format';

type Tab = 'suggestions' | 'planning';

export function Preparation({ me, params }: { me: Me; params: URLSearchParams }) {
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'planning' ? 'planning' : 'suggestions');
  const [fiche, setFiche] = useState<string | null>(params.get('client'));
  const [plan, setPlan] = useState<{ company?: R; visit?: R } | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion(v => v + 1);
  return (
    <>
      <header className="page-head">
        <div><h1>Préparation des visites</h1><p className="muted">Repérer les clients à voir, préparer la visite, la planifier pour un commercial.</p></div>
        <div className="toolbar"><button className="primary" onClick={() => setPlan({})}>+ Planifier une visite</button></div>
      </header>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'suggestions'} className={tab === 'suggestions' ? 'on' : ''} onClick={() => setTab('suggestions')}>Clients à visiter</button>
        <button role="tab" aria-selected={tab === 'planning'} className={tab === 'planning' ? 'on' : ''} onClick={() => setTab('planning')}>Planning</button>
      </div>
      {tab === 'suggestions' ? <Suggestions version={version} onFiche={setFiche} onPlan={company => setPlan({ company })} /> : <Planning version={version} onEdit={visit => setPlan({ visit })} />}
      {fiche && <Fiche id={fiche} onClose={() => setFiche(null)} onPlan={company => { setFiche(null); setPlan({ company }); }} />}
      {plan && <PlanModal me={me} company={plan.company} visit={plan.visit} onClose={() => setPlan(null)} onDone={() => { setPlan(null); refresh(); setTab('planning'); }} />}
    </>
  );
}

function Suggestions({ version, onFiche, onPlan }: { version: number; onFiche: (id: string) => void; onPlan: (c: R) => void }) {
  const [days, setDays] = useState(60); const [user, setUser] = useState(''); const [incl, setIncl] = useState(false);
  const users = useLoad(() => api<R>('prep/commerciaux'), []);
  const { data, error, loading } = useLoad(() => api<R>(`prep/suggestions?days=${days}&include_planned=${incl}${user ? `&user_id=${user}` : ''}`), [days, user, incl, version]);
  return (
    <Card>
      <div className="toolbar filters">
        <label>Sans visite depuis <select value={days} onChange={e => setDays(Number(e.target.value))}>{[30, 60, 90, 180].map(d => <option key={d} value={d}>{d} jours</option>)}</select></label>
        {(users.data?.users?.length ?? 0) > 1 && <label>Commercial <select value={user} onChange={e => setUser(e.target.value)}><option value="">Tous</option>{users.data!.users.map((u: R) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
        <label className="check"><input type="checkbox" checked={incl} onChange={e => setIncl(e.target.checked)} /> Inclure les clients qui ont déjà une visite prévue</label>
      </div>
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Loading />}
      {data && (data.suggestions.length === 0 ? <Empty>Aucun client à signaler : tout est à jour.</Empty> : (
        <div className="scroll"><table><thead><tr><th>Client</th><th>Commerciaux</th><th>Dernière visite</th><th>Motifs</th><th>Actions en retard</th><th>Visite prévue</th><th /></tr></thead><tbody>
          {data.suggestions.map((s: R) => (
            <tr key={s.id}>
              <td><strong>{s.name}</strong><br /><small className="muted">{[s.city, s.sector].filter(Boolean).join(' · ')}</small></td>
              <td>{s.commerciaux ?? '—'}</td>
              <td>{s.last_visit_at ? <>{fmtDate(s.last_visit_at)}<br /><small className="muted">il y a {s.days_since_last_visit} j</small></> : <span className="muted">Jamais</span>}</td>
              <td className="badges"><div>{s.reasons.map((r: string) => <Badge key={r} tone={REASON[r]?.[1]}>{REASON[r]?.[0] ?? r}</Badge>)}</div></td>
              <td className={s.late_actions ? 'red' : ''}>{s.late_actions || '—'}</td>
              <td>{s.next_visit_at ? fmtDate(s.next_visit_at) : '—'}</td>
              <td className="actions"><button onClick={() => onFiche(s.id)}>Préparer</button><button className="primary" onClick={() => onPlan({ id: s.id, name: s.name })}>Planifier</button></td>
            </tr>))}
        </tbody></table></div>))}
    </Card>
  );
}

function Planning({ version, onEdit }: { version: number; onEdit: (v: R) => void }) {
  const { data, error, loading } = useLoad(() => api<R>('prep/visits'), [version]);
  return (
    <Card>
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Loading />}
      {data && (data.visits.length === 0 ? <Empty>Aucune visite à venir (60 prochains jours).</Empty> : (
        <div className="scroll"><table><thead><tr><th>Date</th><th>Client</th><th>Commercial</th><th>Statut</th><th>Objectif</th><th>Planifiée par</th><th /></tr></thead><tbody>
          {data.visits.map((v: R) => (
            <tr key={v.id}>
              <td>{v.planned_start ? fmtDateTime(v.planned_start) : <span className="muted">Non planifiée</span>}</td>
              <td><strong>{v.company}</strong></td><td>{v.author}</td>
              <td><Badge tone={STATUS_TONE[v.status]}>{STATUS[v.status]}</Badge></td>
              <td className="wrap">{v.objective ?? '—'}</td>
              <td>{v.created_by_name && v.created_by_name !== v.author ? v.created_by_name : '—'}</td>
              <td className="actions"><button onClick={() => onEdit(v)}>Modifier</button></td>
            </tr>))}
        </tbody></table></div>))}
    </Card>
  );
}

/** Fiche de préparation d'un client. */
function Fiche({ id, onClose, onPlan }: { id: string; onClose: () => void; onPlan: (c: R) => void }) {
  const { data, error, loading } = useLoad(() => api<R>(`prep/companies/${id}`), [id]);
  const co = data?.company;
  return (
    <Modal wide title={co ? `Préparer : ${co.name}` : 'Fiche de préparation'} onClose={onClose} footer={co && <><button onClick={onClose}>Fermer</button><button className="primary" onClick={() => onPlan({ id: co.id, name: co.name })}>Planifier une visite</button></>}>
      {error && <Alert>{error}</Alert>}{loading && <Loading />}
      {data && <div className="fiche">
        <section><h3>Client</h3>
          <p>{co.address || 'Adresse non renseignée'}{co.sector ? <><br /><span className="muted">Secteur : {co.sector}</span></> : null}</p>
          <p className="muted">Commerciaux : {data.commerciaux.map((u: R) => u.name).join(', ') || '—'}</p>
          <h4>Contacts</h4>
          {data.contacts.length === 0 ? <p className="muted">Aucun contact.</p> : <ul>{data.contacts.map((c: R) => <li key={c.id}><strong>{c.full_name}</strong>{c.job_title ? `, ${c.job_title}` : ''}<br /><small className="muted">{[c.phone, c.email].filter(Boolean).join(' · ')}</small></li>)}</ul>}
        </section>
        <section><h3>Points à aborder</h3>
          {data.agenda.length === 0 ? <p className="muted">Rien à signaler : pas de compte rendu validé ni d'action ouverte.</p> : <ul className="agenda">{data.agenda.map((a: R, i: number) => <li key={i} className={a.kind}>{a.text}</li>)}</ul>}
          <h4>Actions ouvertes ({data.open_actions.length})</h4>
          {data.open_actions.length === 0 ? <p className="muted">Aucune.</p> : <ul>{data.open_actions.map((a: R) => <li key={a.id} className={a.late ? 'red' : ''}>{a.title} <small className="muted">· {a.owner}{a.due_date ? ` · ${fmtDate(a.due_date)}` : ''}</small></li>)}</ul>}
        </section>
        <section className="full"><h3>Dernières visites</h3>
          {data.visits.length === 0 ? <p className="muted">Aucune visite.</p> : data.visits.map((v: R) => (
            <details key={v.id} open={data.visits[0].id === v.id} className="visit-sum">
              <summary><Badge tone={STATUS_TONE[v.status]}>{STATUS[v.status]}</Badge> {fmtDateTime(v.ended_at ?? v.started_at ?? v.planned_start)} · {v.author}{v.report?.opportunity_temperature ? <> · <Badge tone={v.report.opportunity_temperature === 'hot' ? 'red' : 'amber'}>{TEMP[v.report.opportunity_temperature]}</Badge></> : null}</summary>
              {v.objective && <p><strong>Objectif :</strong> {v.objective}</p>}
              {v.report_hidden && <p className="muted">Compte rendu non visible avec vos droits.</p>}
              {v.report ? <dl>{([['summary', 'Résumé'], ['needs', 'Besoins'], ['objections', 'Objections'], ['competitors', 'Concurrents'], ['decisions', 'Décisions'], ['next_step', 'Prochaine étape']] as const).filter(([k]) => v.report[k]).map(([k, l]) => <div key={k}><dt>{l}</dt><dd>{v.report[k]}</dd></div>)}</dl>
                : !v.report_hidden && <p className="muted">Pas de compte rendu validé.</p>}
            </details>))}
        </section>
      </div>}
    </Modal>
  );
}

/** Planification (création) ou modification d'une visite. */
function PlanModal({ me, company, visit, onClose, onDone }: { me: Me; company?: R; visit?: R; onClose: () => void; onDone: () => void }) {
  const edit = !!visit;
  const [companyId, setCompanyId] = useState<string>(company?.id ?? visit?.company_id ?? ''); const [companyName, setCompanyName] = useState<string>(company?.name ?? visit?.company ?? '');
  const [q, setQ] = useState(''); const [found, setFound] = useState<R[]>([]);
  useEffect(() => {
    if (edit || company || q.trim().length < 1) { setFound([]); return; }
    const t = setTimeout(() => { api<R>(`prep/companies?q=${encodeURIComponent(q)}`).then(r => setFound(r.companies)).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [q, edit, company]);
  const users = useLoad(() => api<R>(`prep/commerciaux${companyId ? `?company_id=${companyId}` : ''}`), [companyId]);
  const [userId, setUserId] = useState<string>(visit?.author_id ?? '');
  useEffect(() => { if (!edit && users.data && !users.data.users.some((u: R) => u.id === userId)) setUserId(users.data.users.find((u: R) => u.assigned)?.id ?? (me.role === 'commercial' ? me.id : '')); }, [users.data]);
  const tomorrow = new Date(Date.now() + 86400000); tomorrow.setHours(9, 0, 0, 0);
  const [when, setWhen] = useState(visit?.planned_start ? isoToLocal(visit.planned_start) : isoToLocal(tomorrow.toISOString()));
  const [address, setAddress] = useState<string>(visit?.location_text ?? ''); const [objective, setObjective] = useState<string>(visit?.objective ?? ''); const [notes, setNotes] = useState<string>(visit?.preparation_notes ?? '');
  const [status, setStatus] = useState<string>(visit?.status ?? 'planned');
  const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      if (edit) await api(`prep/visits/${visit!.id}`, { method: 'PATCH', body: { planned_start: localToIso(when), location_text: address.trim() || null, objective: objective.trim() || null, preparation_notes: notes.trim() || null, status } });
      else await api('prep/visits', { method: 'POST', body: { company_id: companyId, user_id: userId, planned_start: localToIso(when), ...(address.trim() ? { location_text: address.trim() } : {}), ...(objective.trim() ? { objective: objective.trim() } : {}), ...(notes.trim() ? { preparation_notes: notes.trim() } : {}) } });
      onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const ok = (edit || (companyId && userId)) && !!when;
  const why = !edit && !companyId ? 'Choisissez un client.' : !edit && !userId ? (users.data && !users.data.users.some((u: R) => u.assigned) ? 'Aucun commercial de votre périmètre n\'est affecté à ce client : affectez-le d\'abord (rubrique Clients).' : 'Choisissez le commercial qui réalisera la visite.') : !when ? 'Indiquez la date et l\'heure.' : '';
  return (
    <Modal title={edit ? 'Modifier la visite' : 'Planifier une visite'} onClose={onClose} footer={<><button onClick={onClose}>Annuler</button><Tip why={why}><button className="primary" disabled={!ok || busy} onClick={() => void save()}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></Tip></>}>
      <div className="form">
        <Field full label="Client">
          {companyId ? <div className="picked"><strong>{companyName}</strong>{!edit && !company && <button className="link" onClick={() => { setCompanyId(''); setCompanyName(''); }}>Changer</button>}</div> : <>
            <input placeholder="Rechercher un client…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
            {found.length > 0 && <ul className="results">{found.map(c => <li key={c.id}><button onClick={() => { setCompanyId(c.id); setCompanyName(c.name); setFound([]); }}>{c.name}<small className="muted"> {c.city ?? ''}</small></button></li>)}</ul>}</>}
        </Field>
        <Field label="Commercial">
          {edit ? <div className="picked"><strong>{visit!.author}</strong></div> : <select value={userId} onChange={e => setUserId(e.target.value)} disabled={!companyId}>
            <option value="">Choisir…</option>{(users.data?.users ?? []).map((u: R) => <option key={u.id} value={u.id} disabled={!!companyId && !u.assigned}>{u.name}{companyId && !u.assigned ? ' (client non affecté)' : ''}</option>)}</select>}
        </Field>
        <Field label="Date et heure"><input type="datetime-local" step={900} value={when} onChange={e => setWhen(e.target.value)} /></Field>
        {edit && <Field label="Statut"><select value={status} onChange={e => setStatus(e.target.value)}><option value="planned">À organiser</option><option value="organized">Organisée avec le client</option><option value="cancelled">Annulée</option></select></Field>}
        <Field full label="Adresse de la visite" hint="Vide : adresse du client."><input value={address} onChange={e => setAddress(e.target.value)} maxLength={500} /></Field>
        <Field full label="Objectif"><input value={objective} onChange={e => setObjective(e.target.value)} maxLength={2000} /></Field>
        <Field full label="Points à aborder" hint="Visibles du commercial dans l'application mobile."><textarea rows={4} value={notes} onChange={e => setNotes(e.target.value)} maxLength={5000} /></Field>
      </div>
      {err && <Alert>{err}</Alert>}
      {!edit && <p className="muted">Le commercial recevra la visite à sa prochaine synchronisation.</p>}
    </Modal>
  );
}

void daysAgo;
