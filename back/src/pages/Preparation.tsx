import { useEffect, useMemo, useState } from 'react';
import { api, type R } from '../api';
import type { Me } from '../App';
import { Alert, Badge, BriefPanel, Card, ClientFilter, Empty, Field, Loading, Modal, Tip, useLoad, errMsg } from '../ui';
import { ROLE, REASON, STATUS, STATUS_TONE, TEMP, daysAgo, fmtDate, fmtDateTime, isoToLocal, localToIso } from '../format';

/** Préparation des visites : fiche client, formulaire de préparation, attribution. Les écrans qui les déclenchent (visites, reporting) affichent `dialogs`. */
export function usePrep(me: Me, onChanged: () => void) {
  const [fiche, setFiche] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ company?: R; visit?: R } | null>(null); const [assign, setAssign] = useState<R | null>(null);
  const dialogs = (
    <>
      {fiche && <Fiche id={fiche} onClose={() => setFiche(null)} onPlan={company => { setFiche(null); setPlan({ company }); }} onEdit={visit => { setFiche(null); setPlan({ visit }); }} />}
      {assign && <AssignModal visit={assign} onClose={() => setAssign(null)} onDone={() => { setAssign(null); onChanged(); }} />}
      {plan && <PlanModal me={me} company={plan.company} visit={plan.visit} onClose={() => setPlan(null)} onDone={() => { setPlan(null); onChanged(); }} />}
    </>
  );
  return { dialogs, openFiche: setFiche, openPlan: (company?: R) => setPlan({ company }), openEdit: (visit: R) => setPlan({ visit }), openAssign: setAssign };
}

export function Suggestions({ version, onFiche, onPlan }: { version: number; onFiche: (id: string) => void; onPlan: (c: R) => void }) {
  const [days, setDays] = useState(60); const [user, setUser] = useState(''); const [incl, setIncl] = useState(true); const [clients, setClients] = useState<string[]>([]);
  const users = useLoad(() => api<R>('prep/commerciaux'), []);
  const { data, error, loading } = useLoad(() => api<R>(`prep/suggestions?days=${days}&include_planned=${incl}${user ? `&user_id=${user}` : ''}${clients.length ? `&company_ids=${clients.join(',')}` : ''}`), [days, user, incl, clients, version]);
  return (
    <Card>
      <div className="toolbar filters">
        <label>Sans visite depuis <select value={days} onChange={e => setDays(Number(e.target.value))}>{[30, 60, 90, 180].map(d => <option key={d} value={d}>{d} jours</option>)}</select></label>
        {(users.data?.users?.length ?? 0) > 1 && <label>Visiteur <select value={user} onChange={e => setUser(e.target.value)}><option value="">Tous</option>{users.data!.users.map((u: R) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
        <ClientFilter value={clients} onChange={setClients} />
        <label className="check"><input type="checkbox" checked={incl} onChange={e => setIncl(e.target.checked)} /> Inclure les clients qui ont déjà une visite prévue</label>
      </div>
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Loading />}
      {data && (data.suggestions.length === 0 ? <Empty>Aucun client à signaler : tout est à jour.</Empty> : (
        <div className="scroll"><table><thead><tr><th>Client</th><th>Visiteurs</th><th>Dernière visite</th><th>Motifs</th><th>Actions en retard</th><th>Visite prévue</th><th /></tr></thead><tbody>
          {data.suggestions.map((s: R) => (
            <tr key={s.id}>
              <td><strong>{s.name}</strong><br /><small className="muted">{[s.city, s.sector].filter(Boolean).join(' · ')}</small></td>
              <td>{s.commerciaux ?? '—'}</td>
              <td>{s.last_visit_at ? <>{fmtDate(s.last_visit_at)}<br /><small className="muted">il y a {s.days_since_last_visit} j</small></> : <span className="muted">Jamais</span>}</td>
              <td className="badges"><div>{s.reasons.map((r: string) => <Badge key={r} tone={REASON[r]?.[1]}>{REASON[r]?.[0] ?? r}</Badge>)}</div></td>
              <td className={s.late_actions ? 'red' : ''}>{s.late_actions || '—'}</td>
              <td>{s.next_visit_at ? fmtDate(s.next_visit_at) : '—'}</td>
              <td className="actions"><button onClick={() => onFiche(s.id)}>Fiche</button><button className="primary" onClick={() => onPlan({ id: s.id, name: s.name })}>Préparer la visite</button></td>
            </tr>))}
        </tbody></table></div>))}
    </Card>
  );
}

/** Visites en préparation par zones (non attribuées, puis une zone par personne). `fixed` : filtre imposé par la vue choisie (en retard, non attribuées). */
export function Planning({ version, fixed, onEdit, onAssign, onOpen }: { version: number; fixed?: { late?: boolean; user?: string }; onEdit: (v: R) => void; onAssign: (v: R) => void; onOpen: (id: string) => void }) {
  const [clients, setClients] = useState<string[]>([]); const [status, setStatus] = useState(''); const [userSel, setUser] = useState(''); const [lateSel, setLate] = useState(false);
  const user = fixed?.user ?? userSel; const late = fixed?.late ?? lateSel;
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [closed, setClosed] = useState<Record<string, boolean>>({});
  const users = useLoad(() => api<R>('prep/commerciaux'), []);
  const qs = [status && `status=${status}`, user && `user_id=${user}`, late && 'late=true', from && `from=${from}`, to && `to=${to}`, clients.length && `company_ids=${clients.join(',')}`].filter(Boolean).join('&');
  const { data, error, loading } = useLoad(() => api<R>(`prep/visits${qs ? `?${qs}` : ''}`), [qs, version]);
  // Zones : visites non attribuées d'abord, puis une zone par personne (visiteurs, responsables, directeurs).
  const zones = useMemo(() => {
    const by = new Map<string, { key: string; title: string; visits: R[] }>();
    for (const v of (data?.visits ?? []) as R[]) {
      const key = v.author_id ?? 'none';
      if (!by.has(key)) by.set(key, { key, title: v.author_id ? `Visites de ${v.author} · ${ROLE[v.author_role] ?? 'Visiteur'}` : 'Visites non attribuées', visits: [] });
      by.get(key)!.visits.push(v);
    }
    return [...by.values()].sort((a, b) => (a.key === 'none' ? -1 : b.key === 'none' ? 1 : a.title.localeCompare(b.title, 'fr')));
  }, [data]);
  return (
    <Card>
      <div className="toolbar filters">
        <ClientFilter value={clients} onChange={setClients} />
        <select aria-label="Statut" value={status} onChange={e => setStatus(e.target.value)}><option value="">À organiser et organisées</option><option value="planned">À organiser avec le client</option><option value="organized">Organisées avec le client</option></select>
        {!fixed?.user && <select aria-label="Attribution" value={user} onChange={e => setUser(e.target.value)}><option value="">Toutes les personnes</option><option value="none">Non attribuées</option>{(users.data?.users ?? []).map((u: R) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
        {fixed?.late === undefined && <label className="check"><input type="checkbox" checked={late} onChange={e => setLate(e.target.checked)} /> En retard seulement</label>}
        <label>Du <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>au <input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      </div>
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Loading />}
      {data && data.late_count > 0 && <Alert kind="warn">{data.late_count} visite{data.late_count > 1 ? 's' : ''} prévue{data.late_count > 1 ? 's' : ''} en retard (date dépassée, visite non commencée).</Alert>}
      {data && (zones.length === 0 ? <Empty>Aucune visite à organiser ou organisée ne correspond.</Empty> : zones.map(z => (
        <div className="zone" key={z.key}>
          <h3><button type="button" className="zone-toggle" aria-expanded={!closed[z.key]} onClick={() => setClosed(c => ({ ...c, [z.key]: !c[z.key] }))}>
            {closed[z.key] ? '▸' : '▾'} {z.title} <span className="count">({z.visits.length}{z.visits.some(v => v.late) ? ` dont ${z.visits.filter(v => v.late).length} en retard` : ''})</span>
          </button></h3>
          {!closed[z.key] && <div className="scroll"><table><thead><tr><th>Date prévue</th><th>Client</th><th>Département</th><th>Statut</th><th>Objectif</th><th>Points à aborder</th><th>Planifiée par</th><th /></tr></thead><tbody>
            {z.visits.map((v: R) => (
              <tr key={v.id} className={v.late ? 'is-late' : ''}>
                <td>{v.planned_start ? fmtDateTime(v.planned_start) : <span className="muted">Date à fixer</span>}{v.late && <> <Badge tone="red">En retard</Badge></>}</td>
                <td><button className="link" onClick={() => onOpen(v.id)}><strong>{v.company}</strong></button></td><td>{String(v.org_path ?? '').split(' › ').slice(-1)[0]}</td>
                <td><Badge tone={STATUS_TONE[v.status]}>{STATUS[v.status]}</Badge></td>
                <td className="wrap">{v.objective ?? '—'}</td><td className="notes-cell">{v.preparation_notes ?? '—'}</td>
                <td>{v.created_by_name && v.created_by_name !== v.author ? v.created_by_name : '—'}</td>
                <td className="actions"><button onClick={() => onEdit(v)}>Préparer</button><button onClick={() => onAssign(v)}>{v.author_id ? 'Réattribuer' : 'Attribuer'}</button></td>
              </tr>))}
          </tbody></table></div>}
        </div>)))}
    </Card>
  );
}

/** Attribuer (ou retirer l'attribution d') une visite en préparation. */
function AssignModal({ visit, onClose, onDone }: { visit: R; onClose: () => void; onDone: () => void }) {
  const { data, error } = useLoad(() => api<R>(`prep/assignees?visit_id=${visit.id}`), [visit.id]);
  const [userId, setUserId] = useState<string>(visit.author_id ?? ''); const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const save = async (u: string | null) => {
    setBusy(true); setErr(undefined);
    try { await api(`prep/visits/${visit.id}`, { method: 'PATCH', body: { user_id: u } }); onDone(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const same = userId === (visit.author_id ?? '');
  return (
    <Modal title={`Attribuer la visite : ${visit.company}`} onClose={onClose} footer={<>
      <button onClick={onClose}>Annuler</button>
      {visit.author_id && <button disabled={busy} onClick={() => void save(null)}>Retirer l'attribution</button>}
      <Tip why={!userId ? 'Choisissez une personne.' : same ? 'Cette personne est déjà attribuée.' : ''}><button className="primary" disabled={busy || !userId || same} onClick={() => void save(userId)}>Attribuer</button></Tip></>}>
      {(error || err) && <Alert>{error ?? err}</Alert>}
      <Field label="Personne" hint="Visiteurs, responsables et directeurs ayant accès au département de la visite et au client. La visite arrive dans leur application à la prochaine synchronisation.">
        <select value={userId} onChange={e => setUserId(e.target.value)}><option value="">Choisir…</option>{(data?.users ?? []).map((u: R) => <option key={u.id} value={u.id}>{u.name} ({ROLE[u.role]}){u.assigned ? ' — client affecté' : ''}</option>)}</select>
      </Field>
    </Modal>
  );
}

/** Fiche de préparation d'un client. */
function Fiche({ id, onClose, onPlan, onEdit }: { id: string; onClose: () => void; onPlan: (c: R) => void; onEdit: (v: R, c: R) => void }) {
  const { data, error, loading } = useLoad(() => api<R>(`prep/companies/${id}`), [id]);
  const co = data?.company;
  return (
    <Modal wide title={co ? `Préparer : ${co.name}` : 'Fiche de préparation'} onClose={onClose} footer={co && <><button onClick={onClose}>Fermer</button><button className="primary" onClick={() => onPlan({ id: co.id, name: co.name })}>Préparer une visite</button></>}>
      {error && <Alert>{error}</Alert>}{loading && <Loading />}
      {data && <div className="fiche">
        <section><h3>Client</h3>
          <p>{co.address || 'Adresse non renseignée'}{co.sector ? <><br /><span className="muted">Secteur : {co.sector}</span></> : null}</p>
          <p className="muted">Visiteurs : {data.commerciaux.map((u: R) => u.name).join(', ') || '—'}</p>
          <h4>Contacts</h4>
          {data.contacts.length === 0 ? <p className="muted">Aucun contact.</p> : <ul>{data.contacts.map((c: R) => <li key={c.id}><strong>{c.full_name}</strong>{c.job_title ? `, ${c.job_title}` : ''}<br /><small className="muted">{[c.phone, c.email].filter(Boolean).join(' · ')}</small></li>)}</ul>}
        </section>
        <section className="full"><h3>Préparer la réunion (IA)</h3><BriefPanel companyId={co.id} /></section>
        <section><h3>Points à aborder</h3>
          {data.agenda.length === 0 ? <p className="muted">Rien à signaler : pas de compte rendu validé ni d'action ouverte.</p> : <ul className="agenda">{data.agenda.map((a: R, i: number) => <li key={i} className={a.kind}>{a.text}</li>)}</ul>}
          <h4>Actions ouvertes ({data.open_actions.length})</h4>
          {data.open_actions.length === 0 ? <p className="muted">Aucune.</p> : <ul>{data.open_actions.map((a: R) => <li key={a.id} className={a.late ? 'red' : ''}>{a.title} <small className="muted">· {a.owner}{a.due_date ? ` · ${fmtDate(a.due_date)}` : ''}</small></li>)}</ul>}
        </section>
        <section className="full"><h3>Visites en préparation ({data.visits.filter((v: R) => ['planned', 'organized'].includes(v.status)).length})</h3>
          {data.visits.filter((v: R) => ['planned', 'organized'].includes(v.status)).length === 0 ? <p className="muted">Aucune visite à organiser ou organisée pour ce client.</p> : <ul>{data.visits.filter((v: R) => ['planned', 'organized'].includes(v.status)).map((v: R) => (
            <li key={v.id}><Badge tone={STATUS_TONE[v.status]}>{STATUS[v.status]}</Badge> {v.planned_start ? fmtDateTime(v.planned_start) : 'date à fixer'}{v.late && <> <Badge tone="red">En retard</Badge></>} · {v.author}
              {v.objective ? <><br /><strong>Objectif :</strong> {v.objective}</> : null}{v.preparation_notes ? <><br /><span className="notes-cell">{v.preparation_notes}</span></> : null}
              {' '}<button onClick={() => onEdit({ ...v, company_id: co.id, company: co.name }, co)}>Préparer</button></li>))}</ul>}
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

/** Préparation d'une visite (création ou modification) : client, personne à qui l'attribuer (facultatif), date (facultative), adresse, objectif, points à aborder, statut. */
function PlanModal({ me, company, visit, onClose, onDone }: { me: Me; company?: R; visit?: R; onClose: () => void; onDone: () => void }) {
  const edit = !!visit;
  const supervisor = me.role !== 'commercial' || me.is_admin;
  const [companyId, setCompanyId] = useState<string>(company?.id ?? visit?.company_id ?? ''); const [companyName, setCompanyName] = useState<string>(company?.name ?? visit?.company ?? '');
  const [q, setQ] = useState(''); const [found, setFound] = useState<R[]>([]);
  useEffect(() => {
    if (edit || company || q.trim().length < 1) { setFound([]); return; }
    const t = setTimeout(() => { api<R>(`prep/companies?q=${encodeURIComponent(q)}`).then(r => setFound(r.companies)).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [q, edit, company]);
  const users = useLoad(() => (edit ? api<R>(`prep/assignees?visit_id=${visit!.id}`) : companyId ? api<R>(`prep/assignees?company_id=${companyId}`) : Promise.resolve({ users: [] })), [companyId]);
  const [userId, setUserId] = useState<string>(visit?.author_id ?? (supervisor ? '' : me.id));
  // Création : par défaut le visiteur affecté au client s'il n'y en a qu'un ; sinon « non attribuée » (responsables) ou soi-même (visiteurs).
  useEffect(() => {
    if (edit || !users.data || !companyId) return;
    const list: R[] = users.data.users; const assigned = list.filter(u => u.assigned);
    if (!supervisor) setUserId(list.some(u => u.id === me.id) ? me.id : '');
    else if (assigned.length === 1) setUserId(assigned[0]!.id);
  }, [users.data]);
  const [when, setWhen] = useState(visit?.planned_start ? isoToLocal(visit.planned_start) : '');
  const [address, setAddress] = useState<string>(visit?.location_text ?? ''); const [objective, setObjective] = useState<string>(visit?.objective ?? ''); const [notes, setNotes] = useState<string>(visit?.preparation_notes ?? '');
  const [status, setStatus] = useState<string>(visit?.status ?? 'planned');
  const [choices, setChoices] = useState<R[]>([]); const [nodeId, setNodeId] = useState('');   // départements possibles quand plusieurs conviennent
  const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const agenda = useLoad(() => (companyId ? api<R>(`prep/companies/${companyId}`) : Promise.resolve(null)), [companyId]);
  const points: R[] = agenda.data?.agenda ?? [];
  const insertPoints = () => setNotes(n => [n.trim(), ...points.map(p => `• ${p.text}`)].filter(Boolean).join('\n'));
  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      const planned_start = when ? localToIso(when) : null;
      if (edit) await api(`prep/visits/${visit!.id}`, { method: 'PATCH', body: { planned_start, location_text: address.trim() || null, objective: objective.trim() || null, preparation_notes: notes.trim() || null, status, ...(userId !== (visit!.author_id ?? '') ? { user_id: userId || null } : {}) } });
      else await api('prep/visits', { method: 'POST', body: { company_id: companyId, user_id: userId || null, ...(nodeId ? { node_id: nodeId } : {}), planned_start, ...(address.trim() ? { location_text: address.trim() } : {}), ...(objective.trim() ? { objective: objective.trim() } : {}), ...(notes.trim() ? { preparation_notes: notes.trim() } : {}) } });
      onDone();
    } catch (e: any) {
      if (e.code === 'org_node_required' && Array.isArray(e.extra?.nodes)) { setChoices(e.extra.nodes); setNodeId(''); setErr(undefined); }
      else setErr(errMsg(e));
    } finally { setBusy(false); }
  };
  const ok = edit || !!companyId;
  const why = choices.length > 0 && !nodeId ? 'Choisissez le département de la visite.' : !ok ? 'Choisissez un client.' : '';
  const title = edit ? `Préparer la visite : ${visit!.company}` : 'Préparer une visite';
  return (
    <Modal title={title} onClose={onClose} footer={<><button onClick={onClose}>Annuler</button><Tip why={why}><button className="primary" disabled={!ok || busy || (choices.length > 0 && !nodeId)} onClick={() => void save()}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></Tip></>}>
      <div className="form">
        <Field full label="Client">
          {companyId ? <div className="picked"><strong>{companyName}</strong>{!edit && !company && <button className="link" onClick={() => { setCompanyId(''); setCompanyName(''); }}>Changer</button>}</div> : <>
            <input placeholder="Rechercher un client…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
            {found.length > 0 && <ul className="results">{found.map(c => <li key={c.id}><button onClick={() => { setCompanyId(c.id); setCompanyName(c.name); setFound([]); }}>{c.name}<small className="muted"> {c.city ?? ''}</small></button></li>)}</ul>}</>}
        </Field>
        <Field label="Attribuée à" hint={supervisor ? 'Facultatif : sans choix, la visite reste non attribuée et apparaît dans la zone « Visites non attribuées ».' : undefined}>
          <select value={userId} onChange={e => setUserId(e.target.value)} disabled={!companyId || !supervisor}>
            {supervisor && <option value="">Non attribuée</option>}{(users.data?.users ?? []).map((u: R) => <option key={u.id} value={u.id}>{u.name} ({ROLE[u.role]}){u.assigned ? ' — client affecté' : ''}</option>)}</select>
        </Field>
        {choices.length > 0 && <Field full label="Département de la visite" hint="Plusieurs départements conviennent : la visite appartient à celui-ci (visible de ses responsables et directeurs)."><select value={nodeId} onChange={e => setNodeId(e.target.value)} autoFocus><option value="">Choisir…</option>{choices.map(n => <option key={n.id} value={n.id}>{n.path}</option>)}</select></Field>}
        <Field label="Date et heure prévues" hint="Facultatif : vide = date à fixer avec le client."><input type="datetime-local" step={900} value={when} onChange={e => setWhen(e.target.value)} /></Field>
        <Field label="Statut"><select value={status} onChange={e => setStatus(e.target.value)} disabled={!edit}><option value="planned">À organiser avec le client</option><option value="organized">Organisée avec le client</option>{edit && <option value="cancelled">Annulée</option>}</select></Field>
        <Field full label="Adresse de la visite" hint="Vide : adresse du client."><input value={address} onChange={e => setAddress(e.target.value)} maxLength={500} /></Field>
        <Field full label="Objectif"><input value={objective} onChange={e => setObjective(e.target.value)} maxLength={2000} /></Field>
        <Field full label="Points à aborder" hint="Visibles dans l'application mobile par la personne attribuée.">
          <textarea rows={5} value={notes} onChange={e => setNotes(e.target.value)} maxLength={5000} />
        </Field>
        {companyId && <div className="full"><BriefPanel companyId={companyId} objective={objective} notes={notes} plannedStart={when ? localToIso(when) : null} onInsert={t => setNotes(n => [n.trim(), t].filter(Boolean).join('\n'))} /></div>}
        {points.length > 0 && <div className="full"><button type="button" onClick={insertPoints}>Insérer les {points.length} points suggérés (dernier compte rendu, actions ouvertes)</button></div>}
      </div>
      {err && <Alert>{err}</Alert>}
    </Modal>
  );
}

void daysAgo;
