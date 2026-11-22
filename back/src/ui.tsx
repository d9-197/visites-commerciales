import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, type R } from './api';

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Une erreur est survenue.');

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>(); const [error, setError] = useState<string>(); const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true; setLoading(true);
    fn().then(d => { if (live) { setData(d); setError(undefined); } }).catch(e => { if (live) setError(errMsg(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: useCallback(() => setTick(t => t + 1), []) };
}

export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="icon" aria-label="Fermer" onClick={onClose}>✕</button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export const Field = ({ label, hint, children, full }: { label: string; hint?: string; children: ReactNode; full?: boolean }) => (
  <label className={`field${full ? ' full' : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
);
/** Rappelle qu'un auteur n'est plus actif ou n'est plus visiteur (ses visites restent affichées). */
export const AuthorState = ({ status, role }: { status?: string; role?: string }) => (<>
  {status === 'disabled' && <> <span className="badge grey" title="Compte désactivé : ses visites restent affichées">Désactivé</span></>}
  {role && role !== 'commercial' && <> <span className="badge blue" title="N'est plus visiteur : ses visites restent affichées">{role === 'manager' ? 'Responsable' : 'Directeur'}</span></>}
</>);
export const Badge = ({ tone = 'grey', children }: { tone?: string; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;
export const Alert = ({ kind = 'error', children }: { kind?: 'error' | 'ok' | 'warn'; children: ReactNode }) => <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
/** Explique pourquoi une action est indisponible : infobulle au survol du bouton grisé (et lue par les lecteurs d'écran), sans alourdir l'écran. */
export const Tip = ({ why, children }: { why?: string; children: ReactNode }) => (why ? <span className="tip" title={why}>{children}</span> : <>{children}</>);
export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;
export const Loading = () => <p className="empty">Chargement…</p>;

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="card">{(title || actions) && <div className="card-head">{title && <h3>{title}</h3>}<div className="spacer" />{actions}</div>}{children}</section>;
}

/** Département de l'organisation : option indentée selon la profondeur (relative au premier département de la liste). */
export function BranchSelect({ nodes, value, onChange, all, label }: { nodes: { id: string; name: string; depth: number }[]; value: string; onChange: (v: string) => void; all?: string; label?: string }) {
  const base = nodes.length ? Math.min(...nodes.map(n => n.depth)) : 0;
  return (
    <select aria-label={label ?? 'Département'} value={value} onChange={e => onChange(e.target.value)}>
      {all !== undefined && <option value="">{all}</option>}
      {nodes.map(n => <option key={n.id} value={n.id}>{'  '.repeat(Math.max(0, n.depth - base))}{n.name}</option>)}
    </select>
  );
}

/** Filtre « Clients » à choix multiple : liste des clients avec recherche et cases à cocher. `value` = identifiants choisis (vide : tous). */
export function ClientFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState('');
  const list = useLoad(() => api<R>('prep/companies?limit=1000'), []);
  const all: R[] = list.data?.companies ?? [];
  const shown = all.filter(c => !q.trim() || `${c.name} ${c.city ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  const label = value.length === 0 ? 'Tous les clients' : value.length === 1 ? (all.find(c => c.id === value[0])?.name ?? '1 client') : `${value.length} clients`;
  return (
    <div className="multi">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label="Clients" onClick={() => setOpen(o => !o)}>{label} ▾</button>
      {open && <div className="multi-pop" role="listbox" aria-multiselectable="true" aria-label="Choix des clients">
        <input type="search" placeholder="Rechercher un client…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
        <div className="multi-actions"><button type="button" className="link" onClick={() => onChange(shown.map(c => c.id))}>Tout cocher{q ? ' (résultats)' : ''}</button><button type="button" className="link" onClick={() => onChange([])}>Effacer</button><button type="button" className="link" onClick={() => setOpen(false)}>Fermer</button></div>
        <ul>{shown.length === 0 ? <li className="muted">Aucun client.</li> : shown.map(c => <li key={c.id}><label className="check"><input type="checkbox" checked={value.includes(c.id)} onChange={() => toggle(c.id)} /> {c.name}{c.city ? <small className="muted"> {c.city}</small> : null}</label></li>)}</ul>
      </div>}
    </div>
  );
}

/** Brief IA d'un client (préparation d'une réunion). `onInsert` : recopie le brief dans un texte (points à aborder). */
export function BriefPanel({ companyId, objective, notes, plannedStart, onInsert }: { companyId: string; objective?: string; notes?: string; plannedStart?: string | null; onInsert?: (text: string) => void }) {
  const [res, setRes] = useState<R>(); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string>();
  const run = async (refresh: boolean) => {
    setBusy(true); setErr(undefined);
    try {
      setRes(await api<R>(`prep/companies/${companyId}/ai-brief`, { method: 'POST', body: { today: new Date().toISOString().slice(0, 10), ...(refresh ? { refresh: true } : {}), ...(objective?.trim() ? { objective: objective.trim() } : {}), ...(notes?.trim() ? { preparation_notes: notes.trim() } : {}), ...(plannedStart ? { planned_start: plannedStart } : {}) } }));
    } catch (e) { setErr(e instanceof ApiError && e.code === 'ai_unavailable' ? "L'IA n'est pas activée sur ce serveur." : errMsg(e)); } finally { setBusy(false); }
  };
  const b = res?.brief as R | null | undefined;
  const text = b ? [b.summary, b.where_we_left && `Dernière visite : ${b.where_we_left}`, ...(b.to_address ?? []).map((t: string) => `• ${t}`), ...(b.watch_out?.length ? ['Vigilance :', ...b.watch_out.map((t: string) => `• ${t}`)] : []), ...(b.questions?.length ? ['Questions :', ...b.questions.map((t: string) => `• ${t}`)] : [])].filter(Boolean).join('\n') : '';
  const list = (title: string, items?: string[]) => items && items.length > 0 && <><h4>{title}</h4><ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul></>;
  return (
    <div className="brief">
      <div className="toolbar"><button onClick={() => void run(!!res)} disabled={busy}>{busy ? 'Préparation…' : res ? '↻ Régénérer le brief' : '✨ Préparer la réunion (IA)'}</button>
        {b && onInsert && <button onClick={() => onInsert(text)}>Insérer dans les points à aborder</button>}</div>
      {err && <Alert>{err}</Alert>}
      {res?.empty && <p className="muted">Pas assez d'informations pour un brief : aucun compte rendu validé ni action ouverte, et pas d'objectif saisi.</p>}
      {b && <div className="brief-body">
        {b.summary && <p><strong>{b.summary}</strong></p>}
        {b.where_we_left && <><h4>Où on en était</h4><p>{b.where_we_left}</p></>}
        {list('À aborder', b.to_address)}{list('Points de vigilance', b.watch_out)}{list('Questions à poser', b.questions)}
        {res!.warnings.length > 0 && <Alert kind="warn">À vérifier : {res!.warnings.join(' ')}</Alert>}
        <p className="muted">Généré par IA à partir de {res!.sources.reports} compte{res!.sources.reports > 1 ? 's' : ''} rendu{res!.sources.reports > 1 ? 's' : ''} validé{res!.sources.reports > 1 ? 's' : ''} et {res!.sources.actions} action{res!.sources.actions > 1 ? 's' : ''} ouverte{res!.sources.actions > 1 ? 's' : ''}{res!.cached ? ' (déjà généré, historique inchangé)' : ''} : relisez avant de vous y fier.</p>
      </div>}
    </div>
  );
}
