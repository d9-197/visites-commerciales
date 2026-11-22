import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';

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
export const Badge = ({ tone = 'grey', children }: { tone?: string; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;
export const Alert = ({ kind = 'error', children }: { kind?: 'error' | 'ok' | 'warn'; children: ReactNode }) => <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;
export const Loading = () => <p className="empty">Chargement…</p>;

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="card">{(title || actions) && <div className="card-head">{title && <h3>{title}</h3>}<div className="spacer" />{actions}</div>}{children}</section>;
}
