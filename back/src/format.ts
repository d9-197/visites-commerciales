export const fmtDate = (v?: string | null) => (v ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(v.length === 10 ? `${v}T12:00:00` : v)) : '—');
export const fmtDateTime = (v?: string | null) => (v ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) : '—');
export const daysAgo = (v?: string | null) => (v ? Math.floor((Date.now() - new Date(v).getTime()) / 86400000) : null);
export const isoDay = (offset = 0) => { const d = new Date(Date.now() + offset * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** Valeur d'un champ datetime-local (heure locale) -> ISO UTC. */
export const localToIso = (v: string) => new Date(v).toISOString();
export const isoToLocal = (v?: string | null) => { if (!v) return ''; const d = new Date(v); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export const STATUS: Record<string, string> = { planned: 'À organiser avec le client', organized: 'Organisée avec le client', in_progress: 'En cours', done: 'Effectuée', validated: 'CR validé', closed: 'Terminée', cancelled: 'Annulée', deleted: 'Supprimée' };
export const STATUS_TONE: Record<string, string> = { planned: 'amber', organized: 'blue', in_progress: 'green', done: 'grey', validated: 'violet', closed: 'green', cancelled: 'grey', deleted: 'grey' };
export const TEMP: Record<string, string> = { cold: 'Froide', warm: 'Tiède', hot: 'Chaude' };
export const ROLE: Record<string, string> = { commercial: 'Commercial', manager: 'Manager', directeur: 'Directeur' };
export const REASON: Record<string, [string, string]> = {
  never_visited: ['Jamais visité', 'amber'], stale: ['Sans visite récente', 'amber'], late_actions: ['Actions en retard', 'red'], hot_no_followup: ['Opportunité chaude sans suite', 'red'],
};
