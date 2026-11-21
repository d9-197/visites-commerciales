// Règles métier partagées entre le back (qui les impose) et l'application (qui les reflète dans l'interface).

export type VisitStatus = 'planned' | 'organized' | 'in_progress' | 'done' | 'validated' | 'cancelled' | 'deleted';
export type UserRole = 'commercial' | 'manager' | 'directeur';

/** « planned » = à organiser ; « organized » = organisée avec le client (rendez-vous confirmé). */
export const VISIT_TRANSITIONS: Record<VisitStatus, readonly VisitStatus[]> = {
  planned: ['organized', 'in_progress', 'cancelled', 'deleted'],
  organized: ['planned', 'in_progress', 'cancelled', 'deleted'],
  in_progress: ['done', 'cancelled', 'deleted'],
  done: ['validated', 'deleted'],   // « validated » est attribué par le serveur quand le compte rendu est validé ; jamais envoyé par l'appareil
  validated: ['deleted'],
  cancelled: ['deleted'],
  deleted: [],
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
  return !['done', 'validated', 'cancelled', 'deleted'].includes(status);
}

/**
 * Suppression d'une visite (statut « supprimée », masquée par défaut) : le commercial auteur de la visite, ou un directeur qui la voit.
 * Refusée tant qu'il reste des actions à faire (voir `canDeleteVisit` côté serveur et application).
 */
export function canDeleteVisit(role: UserRole, isAuthor: boolean): boolean {
  return role === 'directeur' || (role === 'commercial' && isAuthor);
}

/**
 * Notes internes : ajout possible tant que la visite n'est pas supprimée ; une fois le compte rendu validé (visite « validée »),
 * les notes existantes ne se modifient ni ne se suppriment plus (le journal ne se réécrit pas).
 */
export function canEditInternalNote(visitStatus: VisitStatus | string): boolean {
  return !['validated', 'deleted'].includes(visitStatus);
}

/** Jours après la fin de la visite au-delà desquels un compte rendu non validé est signalé en retard. */
export const REPORT_LATE_DAYS = 2;

/** Visite terminée (côté client) dont le compte rendu n'est pas validé depuis plus de REPORT_LATE_DAYS jours. */
export function isReportLate(v: Record<string, any>, now: Date = new Date()): boolean {
  if (v.status !== 'done') return false;
  const t = new Date(v.ended_at ?? v.updated_at ?? '').getTime();
  return !Number.isNaN(t) && t + REPORT_LATE_DAYS * 86_400_000 < now.getTime();
}

/**
 * Échéance d'une action antérieure à la date de la visite (début réel, sinon date prévue). Tolérance d'un jour (fuseaux horaires).
 * Sans date de visite ou sans échéance : jamais en cause.
 */
export function isDueBeforeVisit(due: string | null | undefined, visit: Record<string, any>): boolean {
  const ref = visit.started_at ?? visit.planned_start;
  if (!due || !ref) return false;
  const d = new Date(ref);
  if (Number.isNaN(d.getTime())) return false;
  d.setUTCDate(d.getUTCDate() - 1);
  return due < d.toISOString().slice(0, 10);
}

/** Un compte rendu ne se valide sans action (ni prévue, ni déjà créée) que si « aucune action à prévoir » est coché. */
export function needsNoActionAck(draftCount: number, existingActions: number, noAction: boolean): boolean {
  return draftCount === 0 && existingActions === 0 && !noAction;
}

/**
 * Étape d'une visite pour l'affichage : « validée » (compte rendu validé) devient « terminée » quand plus aucune action n'est à faire.
 * Les autres statuts sont inchangés. `done` s'affiche « effectuée » (le commercial a quitté le client ; il reste le compte rendu et les actions).
 */
export function visitStage(status: VisitStatus | string, openActions: number): string {
  return status === 'validated' && openActions === 0 ? 'closed' : status;
}

/** Le compte rendu ne se valide qu'une fois la visite terminée. */
export function canValidateReport(visitStatus: VisitStatus | string): boolean {
  return visitStatus === 'done';
}

/** Champs d'une visite dont la modification est tracée dans l'historique. */
export const VISIT_HISTORY_FIELDS = ['planned_start', 'location_text'] as const;
/** Événements ajoutés par le serveur à l'historique (sans valeur ancienne/nouvelle). */
export const VISIT_HISTORY_EVENTS = ['report_validated', 'report_reopened', 'visit_deleted'] as const;

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
