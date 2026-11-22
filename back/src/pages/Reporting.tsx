import { useState } from 'react';
import { api, download, type R } from '../api';
import type { Me } from '../App';
import { Alert, AuthorState, Badge, BranchSelect, Card, Empty, Loading, useLoad, errMsg } from '../ui';
import { fmtDate, isoDay } from '../format';
import { CollapseAll, TreeCell, levelName, useCollapsed, useTree, visibleIndexes } from '../tree';

const PRESETS: [string, number][] = [['7 jours', 7], ['30 jours', 30], ['90 jours', 90], ['12 mois', 365]];

export function Reporting({ me }: { me: Me }) {
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
  // Par branche : même arbre que dans Organisation (niveaux colorés, branches repliables) ; les totaux sont déjà consolidés.
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
          {accessNodes.length > 1 && <BranchSelect nodes={accessNodes as any} value={node} onChange={setNode} all="Toutes mes branches" label="Branche" />}
          {multi && <select aria-label="Commercial" value={user} onChange={e => setUser(e.target.value)}><option value="">Tous les commerciaux</option>{users.data!.users.map((u: R) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
          <button onClick={() => void download(`reports/activity.csv?${q}`, `activite-${from}-${to}.csv`).catch(e => setErr(errMsg(e)))}>Exporter en CSV</button>
        </div>
      </header>
      {(error || err) && <Alert>{error ?? err}</Alert>}
      {loading && !data && <Loading />}
      {data && <>
        <div className="kpis">
          <Kpi label="Visites à organiser avec le client" value={data.pipeline.to_organize} sub={`${data.pipeline.organized} organisée${data.pipeline.organized > 1 ? 's' : ''} · ${data.pipeline.late} en retard · ${data.pipeline.unassigned} non attribuée${data.pipeline.unassigned > 1 ? 's' : ''}`} />
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
              <table><thead><tr><th>Client</th><th>Commercial</th><th>Terminée le</th><th>Retard</th></tr></thead><tbody>
                {data.late_reports.map((r: R) => <tr key={r.visit_id}><td><a href={`#/visites?open=${r.visit_id}`}>{r.company}</a></td><td>{r.author}</td><td>{fmtDate(r.ended_at)}</td><td><Badge tone="red">{r.days} j</Badge></td></tr>)}
              </tbody></table>)}
          </Card>
        </div>
        {byNode.length > 1 && <Card title="Par branche (consolidé avec les sous-branches)" actions={<CollapseAll nodes={byNode as any} infos={treeInfo} collapsed={collapsed} set={setCollapsed} />}>
          <div className="scroll"><table className="num tree"><thead><tr><th>Branche</th><th>Niveau</th><th>Membres</th><th>Prévues</th><th>Effectuées</th><th>Annulées</th><th>CR validés</th><th>CR à valider</th><th>CR en retard</th></tr></thead><tbody>
            {shown.map(i => { const n = byNode[i]!; const f = treeInfo[i]!; const closed = f.subs > 0 && collapsed.has(n.id); return (
              <tr key={n.id} className={`lv lv${Math.min(f.rel, 5)}`}>
                <td className="treecell"><TreeCell rel={f.rel} info={f} name={n.name} open={f.subs > 0 && !closed} closed={closed} onToggle={() => { const c = new Set(collapsed); if (c.has(n.id)) c.delete(n.id); else c.add(n.id); setCollapsed(c); }}>
                  <button type="button" className="link nodename" onClick={() => setNode(n.node_id)} title="Descendre dans cette branche">{n.name}</button>
                  {closed && <span className="badge grey" title={`${f.subs} sous-branche${f.subs > 1 ? 's' : ''} repliée${f.subs > 1 ? 's' : ''} (comprises dans les totaux)`}>+{f.subs}</span>}
                </TreeCell></td>
                <td style={{ textAlign: 'left' }}><span className={`lvtag lv${Math.min(f.rel, 5)}`}>{levelName(f.rel)}</span></td>
                <td>{n.members}</td><td>{n.planned}</td><td>{n.done}</td><td>{n.cancelled}</td><td>{n.cr_validated}</td><td>{n.cr_pending}</td><td className={n.cr_late ? 'red' : ''}>{n.cr_late}</td></tr>); })}
          </tbody></table></div>
          <p className="muted">Chaque ligne cumule les visites de la branche et de ses sous-branches, y compris quand elles sont repliées ; cliquez sur le nom d'une branche pour descendre dedans.</p>
        </Card>}
        <Card title="Par commercial">
          {data.by_user.length === 0 ? <Empty>Aucun commercial dans votre périmètre.</Empty> : (
            <div className="scroll"><table className="num"><thead><tr><th>Commercial</th><th>Prévues</th><th>Effectuées</th><th>Annulées</th><th>CR validés</th><th>CR à valider</th><th>CR en retard</th><th>Délai CR (j)</th><th>Actions à faire</th><th>Actions en retard</th></tr></thead><tbody>
              {data.by_user.map((u: R) => <tr key={u.user_id}><td>{u.user_id ? <a href={`#/visites?user=${u.user_id}`}>{u.name}</a> : <a href="#/visites?user=none">{u.name}</a>}<AuthorState status={u.status} role={u.role} /></td><td>{u.planned}</td><td>{u.done}</td><td>{u.cancelled}</td><td>{u.cr_validated}</td><td>{u.cr_pending}</td>
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
