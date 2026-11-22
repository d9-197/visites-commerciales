import { useState } from 'react';
import { api, download, type R } from '../api';
import type { Me } from '../App';
import { Alert, Badge, Card, Empty, Loading, useLoad, errMsg } from '../ui';
import { fmtDate, isoDay } from '../format';

const PRESETS: [string, number][] = [['7 jours', 7], ['30 jours', 30], ['90 jours', 90], ['12 mois', 365]];

export function Reporting({ me }: { me: Me }) {
  const [from, setFrom] = useState(isoDay(-29)); const [to, setTo] = useState(isoDay()); const [user, setUser] = useState('');
  const [err, setErr] = useState<string>();
  const q = `from=${from}&to=${to}${user ? `&user_id=${user}` : ''}`;
  const { data, error, loading } = useLoad(() => api<R>(`reports/activity?${q}`), [q]);
  const users = useLoad(() => api<R>('prep/commerciaux'), []);
  const preset = (n: number) => { setFrom(isoDay(-(n - 1))); setTo(isoDay()); };
  const t = data?.totals; const c = data?.clients;
  const multi = (users.data?.users?.length ?? 0) > 1;
  return (
    <>
      <header className="page-head">
        <div><h1>Reporting d'activité</h1><p className="muted">{data ? (data.scope === 'all' ? 'Toute l\'entreprise' : me.role === 'commercial' ? 'Votre activité' : 'Votre équipe') : ''} · du {fmtDate(from)} au {fmtDate(to)}</p></div>
        <div className="toolbar">
          {PRESETS.map(([l, n]) => <button key={n} className="ghost" onClick={() => preset(n)}>{l}</button>)}
          <input type="date" aria-label="Du" value={from} max={to} onChange={e => setFrom(e.target.value)} />
          <input type="date" aria-label="Au" value={to} min={from} onChange={e => setTo(e.target.value)} />
          {multi && <select aria-label="Commercial" value={user} onChange={e => setUser(e.target.value)}><option value="">Tous les commerciaux</option>{users.data!.users.map((u: R) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
          <button onClick={() => void download(`reports/activity.csv?${q}`, `activite-${from}-${to}.csv`).catch(e => setErr(errMsg(e)))}>Exporter en CSV</button>
        </div>
      </header>
      {(error || err) && <Alert>{error ?? err}</Alert>}
      {loading && !data && <Loading />}
      {data && <>
        <div className="kpis">
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
        <Card title="Par commercial">
          {data.by_user.length === 0 ? <Empty>Aucun commercial dans votre périmètre.</Empty> : (
            <div className="scroll"><table className="num"><thead><tr><th>Commercial</th><th>Prévues</th><th>Effectuées</th><th>Annulées</th><th>CR validés</th><th>CR à valider</th><th>CR en retard</th><th>Délai CR (j)</th><th>Actions à faire</th><th>Actions en retard</th></tr></thead><tbody>
              {data.by_user.map((u: R) => <tr key={u.user_id}><td><a href={`#/visites?user=${u.user_id}`}>{u.name}</a></td><td>{u.planned}</td><td>{u.done}</td><td>{u.cancelled}</td><td>{u.cr_validated}</td><td>{u.cr_pending}</td>
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
