import type { Row } from '@visites/sync-core';

export const VISIT_STATUS: Record<string, string> = { planned: 'Planifiée', in_progress: 'En cours', done: 'Terminée', cancelled: 'Annulée' };

/** « ven. 20 nov. 2026, 10:30 » dans la langue du téléphone ; repli simple si Intl est indisponible. */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try { return d.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
}

/** Libellés de date d'une visite : date principale et complément. */
export function visitWhen(v: Row): { main: string; sub?: string } {
  const planned = v.planned_start ? `Prévue ${fmtDateTime(v.planned_start)}` : 'Non planifiée';
  if (v.status === 'done') return { main: `Réalisée ${fmtDateTime(v.ended_at ?? v.started_at ?? v.updated_at)}`, sub: v.planned_start ? planned : undefined };
  if (v.status === 'in_progress') return { main: `Commencée ${fmtDateTime(v.started_at ?? v.updated_at)}`, sub: v.planned_start ? planned : undefined };
  if (v.status === 'cancelled') return { main: `Annulée · ${planned}` };
  return { main: planned };
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** ISO UTC -> champs date (AAAA-MM-JJ) et heure (HH:MM) en heure locale. */
export function toLocalInputs(iso?: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  return { date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, time: `${p2(d.getHours())}:${p2(d.getMinutes())}` };
}

/** Champs saisis (heure locale) -> ISO UTC, ou undefined si la saisie est invalide. */
export function fromLocalInputs(date: string, time: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '09:00')) return undefined;
  const d = new Date(`${date}T${time || '09:00'}:00`);
  return Number.isNaN(d.getTime()) || toLocalInputs(d.toISOString()).date !== date ? undefined : d.toISOString();
}

// --- Dates seules (échéances d'action) : chaîne AAAA-MM-JJ, sans fuseau, pour éviter tout décalage d'un jour ---

/** « jeu. 26 nov. 2026 » à partir de AAAA-MM-JJ ; chaîne vide si absente. */
export function fmtDate(s?: string | null): string {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  try { return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); } catch { return s; }
}
export function dateToStr(d: Date): string { return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
export function strToDate(s?: string | null): Date | undefined {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

/** Affichage d'un sélecteur : date seule ou date et heure, dans la langue du téléphone. */
export function fmtJsDate(d: Date, mode: 'date' | 'datetime'): string {
  try {
    return mode === 'date'
      ? d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      : d.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return d.toISOString().slice(0, mode === 'date' ? 10 : 16).replace('T', ' '); }
}
