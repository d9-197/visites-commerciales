import { useState } from 'react';
import { api, download, type R } from '../api';
import type { Me } from '../App';
import { Alert, AuthorState, Badge, BranchSelect, Card, Empty, Field, Loading, useLoad, errMsg } from '../ui';
import { Suggestions, usePrep } from './Preparation';
import { fmtDate, isoDay } from '../format';
import { CollapseAll, TreeCell, levelName, useCollapsed, useTree, visibleIndexes } from '../tree';

const PRESETS: [string, number][] = [['7 jours', 7], ['30 jours', 30], ['90 jours', 90], ['12 mois', 365]];

/** Reporting : activité, objectifs mensuels des visiteurs, clients à visiter (avec préparation de la visite). */
export function Reporting({ me, params }: { me: Me; params: URLSearchParams }) {
  const [tab, setTab] = useState(['activity', 'targets', 'tovisit'].includes(params.get('tab') ?? '') ? params.get('tab')! : 'activity');
  const canTarget = me.role !== 'commercial' || me.is_admin;
  const [version, setVersion] = useState(0);
  const prep = usePrep(me, () => setVersion(v => v + 1));
  return (
    <>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activité</button>
        <button role="tab" aria-selected={tab === 'targets'} className={tab === 'targets' ? 'on' : ''} onClick={() => setTab('targets')}>Objectifs mensuels</button>
        <button role="tab" aria-selected={tab === 'tovisit'} className={tab === 'tovisit' ? 'on' : ''} onClick={() => setTab('tovisit')}>Clients à visiter</button>
      </div>
      {tab === 'activity' && <Activity me={me} />}
      {tab === 'targets' && <Targets canEdit={canTarget} />}
      {tab === 'tovisit' && <>
        <header className="page-head"><div><h1>Clients à visiter</h1><p className="muted">Clients sans visite récente, avec actions en retard ou opportunité chaude sans suite. « Préparer la visite » ouvre la préparation (objectif, points à aborder, attribution) ; la visite rejoint alors la liste des visites à organiser avec le client.</p></div></header>
        <Suggestions version={version} onFiche={prep.openFiche} onPlan={prep.openPlan} />
        {prep.dialogs}
      </>}
    </>
  );
}

const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Objectif de visites par visiteur et par mois (visites effectuées ou dont le compte rendu est validé). */
function Targets({ canEdit }: { canEdit: boolean }) {
  const [month, setMonth] = useState(monthOf(new Date()));
  const { data, error, loading, reload } = useLoad(() => api<R>(`targets?month=${month}`), [month]);
  const [vals, setVals] = useState<Record<string, string>>({}); const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string }>(); const [busy, setBusy] = useState(false);
  const rows: R[] = data?.users ?? [];
  const cur = (u: R) => vals[u.user_id] ?? (u.target === null ? '' : String(u.target));
  const dirty = rows.filter(u => cur(u) !== (u.target === null ? '' : String(u.target)));
  const bad = dirty.some(u => cur(u) !== '' && !/^\d{1,4}$/.test(cur(u)));
  const save = async () => {
    setBusy(true); setMsg(undefined);
    try { await api('targets', { method: 'PUT', body: { month, targets: dirty.map(u => ({ user_id: u.user_id, target: cur(u) === '' ? null : Number(cur(u)) })) } }); setVals({}); reload(); setMsg({ kind: 'ok', text: 'Objectifs enregistrés.' }); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(false); }
  };
  const copyPrev = async () => {
    const d = new Date(`${month}-01T12:00:00`); d.setMonth(d.getMonth() - 1);
    try { const p = await api<R>(`targets?month=${monthOf(d)}`); const next: Record<string, string> = {}; for (const u of p.users as R[]) if (u.target !== null) next[u.user_id] = String(u.target); setVals(next); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  return (
    <>
      <header className="page-head"><div><h1>Objectifs mensuels</h1><p className="muted">Nombre de visites à réaliser par visiteur et par mois. Le reporting d'activité compare les visites effectuées à ces objectifs lorsqu'ils sont définis.</p></div>
        <div className="toolbar"><Field label="Mois"><input type="month" value={month} onChange={e => { setMonth(e.target.value); setVals({}); }} /></Field></div></header>
      {(error || msg) && <Alert kind={msg?.kind ?? 'error'}>{msg?.text ?? error}</Alert>}
      <Card>
        {loading && !data && <Loading />}
        {data && (rows.length === 0 ? <Empty>Aucun visiteur dans votre périmètre.</Empty> : <>
          <div className="scroll"><table className="num"><thead><tr><th>Visiteur</th><th>Objectif du mois</th><th>Visites effectuées</th><th>Atteinte</th></tr></thead><tbody>
            {rows.map(u => { const t = u.target; const pct = t ? Math.round(u.done * 100 / t) : null; return (
              <tr key={u.user_id}><td style={{ textAlign: 'left' }}>{u.name}<AuthorState status={u.status} role={u.role} /></td>
                <td>{canEdit ? <input type="number" min={0} max={9999} style={{ width: 90 }} aria-label={`Objectif de ${u.name}`} value={cur(u)} onChange={e => setVals(v => ({ ...v, [u.user_id]: e.target.value }))} placeholder="—" /> : (t ?? '—')}</td>
                <td>{u.done}</td><td>{pct === null ? '—' : <Badge tone={pct >= 100 ? 'green' : pct >= 60 ? 'amber' : 'red'}>{pct} %</Badge>}</td></tr>); })}
          </tbody></table></div>
          {canEdit && <div className="toolbar" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy || dirty.length === 0 || bad} title={bad ? 'Objectifs : nombres entiers de 0 à 9999 (vide : pas d\'objectif).' : dirty.length === 0 ? 'Aucune modification.' : undefined} onClick={() => void save()}>{busy ? 'Enregistrement…' : `Enregistrer${dirty.length ? ` (${dirty.length})` : ''}`}</button>
            <button onClick={() => void copyPrev()} title="Reprend les objectifs du mois précédent (à enregistrer ensuite)">Reprendre le mois précédent</button>
          </div>}
        </>)}
      </Card>
    </>
  );
}

function Activity({ me }: { me: Me }) {
  const [from, setFrom] = useState(isoDay(-29)); const [to, setTo] = useState(isoDay()); const [user, setUser] = useState(''); const [node, setNode] = useState('');
  const [err, setErr] = useState<string>();
  const q = `from=${from}&to=${to}${user ? `&user_id=${user}` : ''}${node ? `&node_id=${node}` : ''}`;
  const branches = useLoad(() => api<R>('org/mine'), []);
  const accessNodes: R[] = branches.data?.access ?? [];
  const { data, error, loading } = useLoad(() => api<R>(`reports/activity?${q}`), [q]);
  const users = useLoad(() => api<R>('prep/commerciaux'), []);
  const preset = (n: number) => { setFrom(isoDay(-(n - 1))); setTo(isoDay()); };
  const t = data?.totals; const c = data?.clients;
  const multi = (users.data?.users?.length ?? 0) > 1;
  // Par département : même arbre que dans Organisation (niveaux colorés, départements repliables) ; les totaux sont déjà consolidés.
  const byNode: R[] = (data?.by_node ?? []).map((n: R) => ({ ...n, id: n.node_id }));
  const treeInfo = useTree(byNode as any);
  const [collapsed, setCollapsed] = useCollapsed('vb.report.collapsed');
  const shown = visibleIndexes(byNode as any, collapsed);
  return (
    <>
      <header className="page-head">
        <div><h1>Reporting d'activité</h1><p className="muted">{data ? (data.scope === 'all' ? 'Toute l\'entreprise' : me.role === 'commercial' ? 'Votre activité' : 'Votre équipe') : ''} · du {fmtDate(from)} au {fmtDate(to)}</p></div>
        <div className="toolbar">
          {PRESETS.map(([l, n]) => <button key={n} className="ghost" onClick={() => preset(n)}>{l}</button>)}
          <input type="date" aria-label="Du" value={from} max={to} onChange={e => setFrom(e.target.value)} />
          <input type="date" aria-label="Au" value={to} min={from} onChange={e => setTo(e.target.value)} />
          {accessNodes.length > 1 && <BranchSelect nodes={accessNodes as any} value={node} onChange={setNode} all="Tous mes départements" label="Département" />}
          {multi && <select aria-label="Visiteur" value={user} onChange={e => setUser(e.target.value)}><option value="">Tous les visiteurs</option>{users.data!.users.map((u: R) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
          <button onClick={() => void download(`reports/activity.csv?${q}`, `activite-${from}-${to}.csv`).catch(e => setErr(errMsg(e)))}>Exporter par visiteur (CSV)</button>
          <button onClick={() => void download(`reports/activity.csv?${q}&by=node`, `activite-departements-${from}-${to}.csv`).catch(e => setErr(errMsg(e)))}>Exporter par département (CSV)</button>
        </div>
      </header>
      {(error || err) && <Alert>{error ?? err}</Alert>}
      {loading && !data && <Loading />}
      {data && <>
        <div className="kpis">
          <Kpi label="Visites à organiser avec le client" value={data.pipeline.to_organize} sub={`${data.pipeline.organized} organisée${data.pipeline.organized > 1 ? 's' : ''} · ${data.pipeline.late} en retard · ${data.pipeline.unassigned} non attribuée${data.pipeline.unassigned > 1 ? 's' : ''}`} />
          {data.targets_defined && <Kpi label="Objectif de visites" value={`${t.done} / ${t.target}`} tone={t.target > 0 && t.done < t.target ? 'amber' : undefined} sub={t.target > 0 ? `${Math.round(t.done * 100 / t.target)} % de l'objectif des mois de la période` : 'Objectifs à 0'} />}
          <Kpi label="Visites effectuées" value={t.done} sub={`${t.planned} prévue${t.planned > 1 ? 's' : ''} · ${t.in_progress} en cours · ${t.cancelled} annulée${t.cancelled > 1 ? 's' : ''}`} />
          <Kpi label="Comptes rendus validés" value={t.cr_validated} sub={t.avg_cr_delay_days === null ? 'Délai moyen : —' : `Délai moyen de validation : ${t.avg_cr_delay_days} j`} />
          <Kpi label="CR à valider" value={t.cr_pending} tone={t.cr_late > 0 ? 'red' : undefined} sub={t.cr_late > 0 ? `${t.cr_late} en retard (> 2 jours)` : 'Aucun en retard'} />
          <Kpi label="Actions à faire" value={t.actions_todo} tone={t.actions_late > 0 ? 'red' : undefined} sub={`${t.actions_late} en retard · ${t.actions_done} terminée${t.actions_done > 1 ? 's' : ''} sur la période`} />
          <Kpi label="Clients visités" value={`${c.visited} / ${c.total}`} sub={`${c.not_visited_90d} sans visite depuis 90 jours`} tone={c.not_visited_90d > 0 ? 'amber' : undefined} />
        </div>
        <div className="grid2">
          <Card title="Visites effectuées par semaine"><WeekChart rows={data.by_week} /></Card>
          <Card title={`Comptes rendus à valider depuis plus de 2 jours (${data.late_reports.length})`}>
            {data.late_reports.length === 0 ? <Empty>Aucun compte rendu en retard.</Empty> : (
              <table><thead><tr><th>Client</th><th>Visiteur</th><th>Terminée le</th><th>Retard</th></tr></thead><tbody>
                {data.late_reports.map((r: R) => <tr key={r.visit_id}><td><a href={`#/visites?open=${r.visit_id}`}>{r.company}</a></td><td>{r.author}</td><td>{fmtDate(r.ended_at)}</td><td><Badge tone="red">{r.days} j</Badge></td></tr>)}
              </tbody></table>)}
          </Card>
        </div>
        {byNode.length > 1 && <Card title="Par département (consolidé avec les sous-départements)" actions={<CollapseAll nodes={byNode as any} infos={treeInfo} collapsed={collapsed} set={setCollapsed} />}>
          <div className="scroll"><table className="num tree"><thead><tr><th>Département</th><th>Niveau</th><th>Membres</th><th>Prévues</th><th>Effectuées</th><th>Annulées</th><th>CR validés</th><th>CR à valider</th><th>CR en retard</th></tr></thead><tbody>
            {shown.map(i => { const n = byNode[i]!; const f = treeInfo[i]!; const closed = f.subs > 0 && collapsed.has(n.id); return (
              <tr key={n.id} className={`lv lv${Math.min(f.rel, 5)}`}>
                <td className="treecell"><TreeCell rel={f.rel} info={f} name={n.name} open={f.subs > 0 && !closed} closed={closed} onToggle={() => { const c = new Set(collapsed); if (c.has(n.id)) c.delete(n.id); else c.add(n.id); setCollapsed(c); }}>
                  <button type="button" className="link nodename" onClick={() => setNode(n.node_id)} title="Descendre dans ce département">{n.name}</button>
                  {closed && <span className="badge grey" title={`${f.subs} sous-département${f.subs > 1 ? 's' : ''} replié${f.subs > 1 ? 's' : ''} (compris dans les totaux)`}>+{f.subs}</span>}
                </TreeCell></td>
                <td style={{ textAlign: 'left' }}><span className={`lvtag lv${Math.min(f.rel, 5)}`}>{levelName(f.rel)}</span></td>
                <td>{n.members}</td><td>{n.planned}</td><td>{n.done}</td><td>{n.cancelled}</td><td>{n.cr_validated}</td><td>{n.cr_pending}</td><td className={n.cr_late ? 'red' : ''}>{n.cr_late}</td></tr>); })}
          </tbody></table></div>
          <p className="muted">Chaque ligne cumule les visites du département et de ses sous-départements, y compris quand elles sont repliées ; cliquez sur le nom d'un département pour descendre dedans.</p>
        </Card>}
        <Card title="Par visiteur">
          {data.by_user.length === 0 ? <Empty>Aucun visiteur dans votre périmètre.</Empty> : (
            <div className="scroll"><table className="num"><thead><tr><th>Visiteur</th>{data.targets_defined && <th>Objectif</th>}{data.targets_defined && <th>Atteinte</th>}<th>Prévues</th><th>Effectuées</th><th>Annulées</th><th>CR validés</th><th>CR à valider</th><th>CR en retard</th><th>Délai CR (j)</th><th>Actions à faire</th><th>Actions en retard</th></tr></thead><tbody>
              {data.by_user.map((u: R) => <tr key={u.user_id}><td>{u.user_id ? <a href={`#/visites?user=${u.user_id}`}>{u.name}</a> : <a href="#/visites?user=none">{u.name}</a>}<AuthorState status={u.status} role={u.role} /></td>{data.targets_defined && <td>{u.target ?? '—'}</td>}{data.targets_defined && <td>{u.target ? <Badge tone={u.done >= u.target ? 'green' : u.done * 100 >= u.target * 60 ? 'amber' : 'red'}>{Math.round(u.done * 100 / u.target)} %</Badge> : '—'}</td>}<td>{u.planned}</td><td>{u.done}</td><td>{u.cancelled}</td><td>{u.cr_validated}</td><td>{u.cr_pending}</td>
                <td className={u.cr_late ? 'red' : ''}>{u.cr_late}</td><td>{u.avg_cr_delay_days ?? '—'}</td><td>{u.actions_todo}</td><td className={u.actions_late ? 'red' : ''}>{u.actions_late}</td></tr>)}
            </tbody></table></div>)}
        </Card>
      </>}
    </>
  );
}

const Kpi = ({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: string }) => (
  <div className={`kpi ${tone ?? ''}`}><span>{label}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</div>
);

/** Histogramme SVG simple : une barre par semaine. */
function WeekChart({ rows }: { rows: { week: string; done: number }[] }) {
  if (rows.length === 0) return <Empty>Aucune visite effectuée sur la période.</Empty>;
  const max = Math.max(...rows.map(r => r.done), 1); const W = 560, H = 180, pad = 24, bw = Math.min(40, (W - pad * 2) / rows.length - 6);
  return (
    <svg viewBox={`0 0 ${W} ${H + 24}`} role="img" aria-label="Visites effectuées par semaine" className="chart">
      <line x1={pad} y1={H} x2={W - pad} y2={H} className="axis" />
      {rows.map((r, i) => {
        const h = Math.round((r.done / max) * (H - 24)); const x = pad + i * ((W - pad * 2) / rows.length) + 3;
        return <g key={r.week}><rect x={x} y={H - h} width={bw} height={h} rx="3" className="bar"><title>{`Semaine du ${fmtDate(r.week)} : ${r.done}`}</title></rect>
          <text x={x + bw / 2} y={H - h - 4} textAnchor="middle" className="val">{r.done}</text>
          {(rows.length <= 12 || i % 2 === 0) && <text x={x + bw / 2} y={H + 16} textAnchor="middle" className="lab">{new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' }).format(new Date(r.week))}</text>}</g>;
      })}
    </svg>
  );
}
