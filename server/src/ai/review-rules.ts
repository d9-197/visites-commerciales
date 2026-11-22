import { numbersIn } from './guards.js';
import type { ReviewInput, ReviewIssue } from './types.js';

/**
 * Contrôles du compte rendu qui ne demandent pas d'IA (toujours exécutés, gratuits, déterministes).
 * Ils signalent ; ils n'empêchent jamais la validation (les règles bloquantes sont celles de l'application).
 */
export function reviewByRules(i: ReviewInput): ReviewIssue[] {
  const out: ReviewIssue[] = [];
  const add = (field: ReviewIssue['field'], severity: ReviewIssue['severity'], message: string) => out.push({ field, severity, message, source: 'rules' });
  const f = i.fields; const filled = Object.values(f).some(x => x.trim());
  if (!f.summary.trim()) add('summary', 'warning', 'Le résumé est vide.');
  if (filled && !i.temperature) add('general', 'info', "L'opportunité (froide, tiède, chaude) n'est pas renseignée.");
  if (i.temperature === 'hot' && !f.next_step.trim() && i.actions.length === 0) add('next_step', 'warning', 'Opportunité chaude sans prochaine étape ni action : quelle suite est prévue ?');
  if (f.next_step.trim() && i.actions.length === 0 && !i.noAction) add('actions', 'info', 'Une prochaine étape est indiquée, mais aucune action n\'est prévue.');
  if (f.objections.trim() && !f.decisions.trim() && !f.next_step.trim()) add('objections', 'info', 'Des objections sont notées, sans décision ni prochaine étape pour les lever.');
  for (const a of i.actions) {
    if (!a.due_date) add('actions', 'info', `Action sans échéance : « ${a.title} ».`);
    else if (a.due_date < i.today) add('actions', 'warning', `Échéance dans le passé : « ${a.title} » (${a.due_date}).`);
  }
  // Nombres (montants, quantités) présents dans les notes mais absents du compte rendu et des actions.
  if (i.notes.trim()) {
    const inReport = numbersIn([...Object.values(f), ...i.actions.map(a => a.title)].join(' '));
    const missing = [...numbersIn(i.notes)].filter(n => n.length >= 2 && !inReport.has(n) && !/^(19|20)\d\d$/.test(n)).slice(0, 4);
    if (missing.length) add('general', 'info', `Nombre${missing.length > 1 ? 's' : ''} présent${missing.length > 1 ? 's' : ''} dans les notes mais pas dans le compte rendu : ${missing.join(', ')}.`);
  }
  return out;
}
