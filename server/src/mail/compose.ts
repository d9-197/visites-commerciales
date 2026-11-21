// Composition de l'e-mail d'une visite : notes durant visite, actions, compte rendu validé. Jamais de notes internes ni privées.

export type EmailPart = 'report' | 'actions' | 'notes';

export interface EmailInput {
  company: string; plannedStart: string | null; startedAt: string | null; endedAt: string | null; location: string | null;
  senderName: string; message?: string; brandName?: string;
  report?: { summary: string | null; needs: string | null; objections: string | null; competitors: string | null; decisions: string | null; next_step: string | null; opportunity_temperature: string | null };
  actions?: { title: string; due_date: string | null; status: string }[];
  notes?: { body: string }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nl2br = (s: string) => esc(s).replace(/\r?\n/g, '<br>');
const TEMP: Record<string, string> = { cold: 'froide', warm: 'tiède', hot: 'chaude' };
const STATUS: Record<string, string> = { todo: 'à faire', done: 'terminée', cancelled: 'annulée' };
const FIELDS: [keyof NonNullable<EmailInput['report']>, string][] = [
  ['summary', 'Résumé'], ['needs', 'Besoins'], ['objections', 'Objections'], ['competitors', 'Concurrents'], ['decisions', 'Décisions'], ['next_step', 'Prochaine étape'],
];
const fmt = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(d);
};
const fmtDay = (day: string) => { const d = new Date(`${day}T12:00:00Z`); return Number.isNaN(d.getTime()) ? day : new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeZone: 'UTC' }).format(d); };

export function composeVisitEmail(i: EmailInput): { subject: string; text: string; html: string } {
  const when = fmt(i.startedAt ?? i.plannedStart);
  const subject = `Visite ${i.company}${when ? ` – ${when}` : ''}`;
  const head = [['Client', i.company], ['Date', when], ['Adresse', i.location]].filter(([, v]) => v) as [string, string][];
  const text: string[] = [`${i.senderName} partage une visite.`, ''];
  const html: string[] = [`<p>${esc(i.senderName)} partage une visite.</p>`];
  if (i.message?.trim()) { text.push(i.message.trim(), ''); html.push(`<p>${nl2br(i.message.trim())}</p>`); }
  text.push(...head.map(([k, v]) => `${k} : ${v}`), '');
  html.push(`<table cellpadding="4">${head.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>`);

  if (i.report) {
    text.push('COMPTE RENDU', '');
    html.push('<h3>Compte rendu</h3>');
    for (const [k, label] of FIELDS) {
      const v = i.report[k]; if (!v || !String(v).trim()) continue;
      text.push(`${label} :`, String(v).trim(), ''); html.push(`<p><b>${esc(label)}</b><br>${nl2br(String(v).trim())}</p>`);
    }
    const t = i.report.opportunity_temperature && TEMP[i.report.opportunity_temperature];
    if (t) { text.push(`Opportunité : ${t}`, ''); html.push(`<p><b>Opportunité</b> : ${esc(t)}</p>`); }
  }
  if (i.actions) {
    text.push('ACTIONS', ''); html.push('<h3>Actions</h3>');
    if (i.actions.length === 0) { text.push('Aucune action.', ''); html.push('<p>Aucune action.</p>'); }
    else {
      for (const a of i.actions) text.push(`- ${a.title} (${STATUS[a.status] ?? a.status}${a.due_date ? `, échéance ${fmtDay(a.due_date)}` : ''})`);
      text.push('');
      html.push(`<ul>${i.actions.map(a => `<li>${esc(a.title)} <i>(${esc(STATUS[a.status] ?? a.status)}${a.due_date ? `, échéance ${esc(fmtDay(a.due_date))}` : ''})</i></li>`).join('')}</ul>`);
    }
  }
  if (i.notes) {
    text.push('NOTES DURANT LA VISITE', ''); html.push('<h3>Notes durant la visite</h3>');
    if (i.notes.length === 0) { text.push('Aucune note.', ''); html.push('<p>Aucune note.</p>'); }
    else {
      for (const n of i.notes) text.push(`- ${n.body.trim().replace(/\r?\n/g, '\n  ')}`);
      text.push(''); html.push(`<ul>${i.notes.map(n => `<li>${nl2br(n.body.trim())}</li>`).join('')}</ul>`);
    }
  }
  const app = i.brandName?.trim() || 'Visites commerciales';
  text.push(`— Envoyé depuis ${app}. Les notes internes ne sont jamais incluses.`);
  html.push(`<hr><p style="color:#666;font-size:12px">Envoyé depuis ${esc(app)}. Les notes internes ne sont jamais incluses.</p>`);
  return { subject, text: text.join('\n'), html: html.join('\n') };
}
