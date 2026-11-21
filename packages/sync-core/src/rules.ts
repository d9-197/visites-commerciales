// Règles métier partagées entre le back (qui les impose) et l'application (qui les reflète dans l'interface).

export type VisitStatus = 'planned' | 'organized' | 'in_progress' | 'done' | 'validated' | 'cancelled';
export type UserRole = 'commercial' | 'manager' | 'directeur';

/** « planned » = à organiser ; « organized » = organisée avec le client (rendez-vous confirmé). */
export const VISIT_TRANSITIONS: Record<VisitStatus, readonly VisitStatus[]> = {
  planned: ['organized', 'in_progress', 'cancelled'],
  organized: ['planned', 'in_progress', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: ['validated'],   // « validated » est attribué par le serveur quand le compte rendu est validé ; jamais envoyé par l'appareil
  validated: [],
  cancelled: [],
};

export const canTransition = (from: VisitStatus, to: VisitStatus) => from === to || VISIT_TRANSITIONS[from].includes(to);

/**
 * Adresse de la visite :
 *  - avant l'organisation avec le client : toute personne qui peut voir la visite ;
 *  - une fois organisée : les commerciaux seulement ;
 *  - dès que la visite est commencée : plus modifiable.
 */
export function canEditVisitAddress(status: VisitStatus, role: UserRole): boolean {
  return status === 'planned' || (status === 'organized' && role === 'commercial');
}

/** Date prévue : l'auteur de la visite, tant qu'elle n'est pas commencée. */
export function canEditVisitDate(status: VisitStatus, isAuthor: boolean): boolean {
  return isAuthor && (status === 'planned' || status === 'organized');
}

/** Notes durant visite : plus modifiables (ajout, modification, suppression) une fois la visite terminée, validée ou annulée. */
export function canEditVisitNotes(status: VisitStatus | string): boolean {
  return !['done', 'validated', 'cancelled'].includes(status);
}

/** Le compte rendu ne se valide qu'une fois la visite terminée. */
export function canValidateReport(visitStatus: VisitStatus | string): boolean {
  return visitStatus === 'done';
}

/** Champs d'une visite dont la modification est tracée dans l'historique. */
export const VISIT_HISTORY_FIELDS = ['planned_start', 'location_text'] as const;

/** Marge avant de considérer une visite non commencée comme en retard (l'heure par défaut d'une nouvelle visite est « maintenant »). */
export const VISIT_LATE_GRACE_MINUTES = 60;

/** Visite à organiser ou organisée dont l'heure prévue est dépassée (de plus de la marge) sans qu'elle ait commencé. */
export function isVisitLate(v: Record<string, any>, now: Date = new Date()): boolean {
  if (v.status !== 'planned' && v.status !== 'organized') return false;
  if (!v.planned_start) return false;
  const t = new Date(v.planned_start).getTime();
  return !Number.isNaN(t) && t + VISIT_LATE_GRACE_MINUTES * 60_000 < now.getTime();
}

/** Action à faire dont l'échéance (AAAA-MM-JJ) est strictement avant aujourd'hui (date locale AAAA-MM-JJ). */
export function isActionLate(a: Record<string, any>, today: string): boolean {
  return a.status === 'todo' && !!a.due_date && a.due_date < today;
}
