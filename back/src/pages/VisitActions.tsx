import { useEffect, useRef, useState } from 'react';
import { ApiError, api, deviceId, mobileApi, mobileUpload, type R } from '../api';
import type { Me } from '../App';
import { Alert, Badge, Field, Loading, Modal, Tip, useLoad, errMsg } from '../ui';
import { ROLE, STATUS, STATUS_TONE, TEMP, fmtDate, fmtDateTime } from '../format';

const uid = () => crypto.randomUUID();
const FIELDS: [string, string][] = [['summary', 'Résumé'], ['needs', 'Besoins'], ['objections', 'Objections'], ['competitors', 'Concurrents'], ['decisions', 'Décisions'], ['next_step', 'Prochaine étape']];
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Messages d'erreur de l'IA et de la dictée (mêmes codes que l'application mobile). */
const aiMessage = (e: unknown): string => {
  const code = e instanceof ApiError ? e.code : '';
  return ({ ai_unavailable: "L'IA n'est pas activée sur ce serveur.", quota_exceeded: "Plafond mensuel d'IA atteint.", rate_limited: 'Trop de demandes : réessayez dans une minute.',
    ai_failed: "Le service d'IA n'a pas pu répondre. Réessayez.", forbidden: "Seul l'auteur de la visite peut le faire.", ai_not_available: "Pas possible à ce moment de la visite (visite pas commencée, ou compte rendu validé)." } as Record<string, string>)[code] ?? errMsg(e);
};

/** Envoie des opérations à l'API de synchronisation (comme l'application mobile) ; lève une erreur si l'une est refusée ou en conflit. */
async function pushOps(ops: R[]) {
  const r = await mobileApi<R>('sync/push', { method: 'POST', body: { device_id: deviceId(), operations: ops } });
  const bad = (r.results as R[]).find(x => x.result !== 'applied');
  if (bad) throw new ApiError(409, bad.code ?? bad.result, bad.result === 'conflict' ? 'Le compte rendu a été modifié ailleurs (application mobile ?) : rechargez et recommencez.' : bad.message ?? 'Opération refusée');
}
const op = (entity: string, id: string, kind: 'create' | 'update' | 'delete', payload: R, base_version?: number): R => ({ id: uid(), entity, entity_id: id, op: kind, ...(base_version !== undefined ? { base_version } : {}), payload });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Envoi par e-mail

/** Envoi d'une visite par e-mail (compte rendu validé, actions, notes durant visite) : mêmes destinataires et règles que l'application mobile. */
export function EmailModal({ visitId, company, onClose, onSent }: { visitId: string; company: string; onClose: () => void; onSent: (text: string) => void }) {
  const { data, error, loading } = useLoad(() => mobileApi<R>(`visits/${visitId}/email-options`), [visitId]);
  const [to, setTo] = useState<string[]>([]); const [parts, setParts] = useState<string[]>([]); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string>();
  useEffect(() => { if (data) { setTo((data.recipients as R[]).filter(r => r.kind === 'self').map(r => r.id)); setParts(Object.entries(data.parts as R).filter(([k, v]) => (k === 'report' ? v : Number(v) > 0)).map(([k]) => k)); } }, [data]);
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const send = async () => {
    setBusy(true); setErr(undefined);
    try { const r = await mobileApi<R>(`visits/${visitId}/email`, { method: 'POST', body: { recipient_ids: to, parts, ...(message.trim() ? { message: message.trim() } : {}) } }); onSent(`E-mail envoyé à ${(r.sent_to as string[]).join(', ')}.`); }
    catch (e) { setErr(e instanceof ApiError && e.code === 'email_unavailable' ? "L'envoi d'e-mail n'est pas configuré sur ce serveur." : e instanceof ApiError && e.code === 'email_failed' ? "Le serveur de messagerie n'a pas accepté l'e-mail. Réessayez plus tard." : errMsg(e)); }
    finally { setBusy(false); }
  };
  const p = data?.parts as R | undefined;
  const why = !data ? '' : !data.configured ? "L'envoi d'e-mail n'est pas configuré sur ce serveur." : to.length === 0 ? 'Choisissez au moins un destinataire.' : parts.length === 0 ? 'Choisissez au moins un élément à envoyer.' : '';
  return (
    <Modal title={`Envoyer par e-mail : ${company}`} onClose={onClose} footer={<><button onClick={onClose}>Annuler</button><Tip why={why}><button className="primary" disabled={!!why || busy || !data} onClick={() => void send()}>{busy ? 'Envoi…' : 'Envoyer'}</button></Tip></>}>
      {(error || err) && <Alert>{error ?? err}</Alert>}{loading && <Loading />}
      {data && <div className="form one">
        <Field label="Destinataires" hint="Vous, et les responsables au-dessus de vous dans l'organisation.">
          <div className="checks">{(data.recipients as R[]).map(r => <label key={r.id} className="check"><input type="checkbox" checked={to.includes(r.id)} onChange={() => toggle(to, setTo, r.id)} /> {r.kind === 'self' ? `Moi (${r.email})` : `${r.name} · ${ROLE[r.role] ?? r.role} (${r.email})`}</label>)}</div>
        </Field>
        <Field label="Contenu">
          <div className="checks">
            <Tip why={p!.report ? '' : "Le compte rendu n'est pas validé."}><label className="check"><input type="checkbox" disabled={!p!.report} checked={parts.includes('report')} onChange={() => toggle(parts, setParts, 'report')} /> Compte rendu validé</label></Tip>
            <Tip why={p!.actions > 0 ? '' : "Aucune action pour cette visite."}><label className="check"><input type="checkbox" disabled={!(p!.actions > 0)} checked={parts.includes('actions')} onChange={() => toggle(parts, setParts, 'actions')} /> Actions ({p!.actions})</label></Tip>
            <Tip why={p!.notes > 0 ? '' : "Aucune note durant la visite."}><label className="check"><input type="checkbox" disabled={!(p!.notes > 0)} checked={parts.includes('notes')} onChange={() => toggle(parts, setParts, 'notes')} /> Notes durant la visite ({p!.notes})</label></Tip>
          </div>
          <small>Les notes internes et privées ne sont jamais envoyées.</small>
        </Field>
        <Field label="Message (facultatif)"><textarea rows={3} value={message} onChange={e => setMessage(e.target.value)} maxLength={2000} /></Field>
      </div>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Dictée

/** Bouton micro : enregistre dans le navigateur, envoie à la transcription (Voxtral) et rend le texte. Un seul enregistrement à la fois (géré par `active`). */
function Mic({ visitId, id, label, active, setActive, onText, onError }: { visitId: string; id: string; label: string; active: string | null; setActive: (v: string | null) => void; onText: (t: string) => void; onError: (m: string) => void }) {
  const rec = useRef<MediaRecorder | null>(null); const chunks = useRef<Blob[]>([]); const t0 = useRef(0); const timer = useRef<number>(); const [busy, setBusy] = useState(false);
  const recording = active === id;
  const stop = () => { window.clearTimeout(timer.current); rec.current?.state === 'recording' && rec.current.stop(); };
  const start = async () => {
    onError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { onError("Votre navigateur ne permet pas l'enregistrement audio."); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { onError("Accès au micro refusé : autorisez-le dans le navigateur."); return; }
    const mr = new MediaRecorder(stream); chunks.current = []; rec.current = mr; t0.current = Date.now();
    mr.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); setActive(null);
      const blob = new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' }); const secs = Math.max(1, Math.round((Date.now() - t0.current) / 1000));
      if (blob.size < 500) { onError('Enregistrement trop court.'); return; }
      setBusy(true);
      try { const r = await mobileUpload<R>(`visits/${visitId}/transcriptions?duration_s=${secs}`, blob); if (String(r.text ?? '').trim()) onText(String(r.text).trim()); else onError('Aucun texte reconnu.'); }
      catch (e) { onError(e instanceof ApiError && e.code === 'ai_unavailable' ? "La transcription vocale n'est pas activée sur ce serveur." : aiMessage(e)); } finally { setBusy(false); }
    };
    mr.start(); setActive(id); timer.current = window.setTimeout(stop, 300_000);     // arrêt automatique après 5 minutes
  };
  useEffect(() => () => { window.clearTimeout(timer.current); rec.current?.state === 'recording' && rec.current.stop(); }, []);
  return <button type="button" className={`mic${recording ? ' rec' : ''}`} aria-label={recording ? 'Arrêter la dictée' : `Dicter : ${label}`} title={recording ? 'Arrêter et transcrire' : `Dicter : ${label}`} disabled={busy || (!!active && !recording)} onClick={() => (recording ? stop() : void start())}>{busy ? '…' : recording ? '■' : '🎤'}</button>;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Compte rendu

interface Draft { id: string; title: string; due_date: string | null; origin: 'ai' | 'manual' }

/**
 * Saisie et finalisation du compte rendu depuis le back, avec les fonctions de l'application mobile : notes durant la visite, fin du rendez-vous, champs du compte rendu
 * avec dictée, actions prévues, génération par IA, contrôle par IA, enregistrement, validation, remise en brouillon. Les écritures passent par la même API de synchronisation
 * que le mobile (mêmes règles, mêmes refus). Réservé à l'auteur de la visite.
 */
export function ReportEditor({ visitId, me, onClose, onChanged }: { visitId: string; me: Me; onClose: () => void; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad(() => api<R>(`visits/${visitId}`), [visitId]);
  const lang = useLoad(() => mobileApi<R>('me'), []);
  const v = data?.visit as R | undefined; const report = data?.report as R | null | undefined;
  const [f, setF] = useState<Record<string, string>>({}); const [temp, setTemp] = useState(''); const [drafts, setDrafts] = useState<Draft[]>([]); const [noAction, setNoAction] = useState(false);
  const [dirty, setDirty] = useState(false); const sig = `${report?.id ?? 'new'}:${report?.version ?? 0}:${report?.status ?? ''}`;
  useEffect(() => {
    if (!data) return;
    setF(Object.fromEntries(FIELDS.map(([k]) => [k, (report?.[k] as string | null) ?? '']))); setTemp((report?.opportunity_temperature as string | null) ?? '');
    setDrafts(Array.isArray(report?.draft_actions) ? report!.draft_actions as Draft[] : []); setNoAction(!!report?.no_action); setDirty(false);
  }, [sig, data?.visit?.status]);       // rechargé à chaque nouvelle version du compte rendu
  const [busy, setBusy] = useState<string>(); const [err, setErr] = useState<string>(); const [ok, setOk] = useState<string>();
  const [active, setActive] = useState<string | null>(null);
  const [proposal, setProposal] = useState<R>(); const [review, setReview] = useState<R>();
  const [actionEdit, setActionEdit] = useState<{ index: number | null; title: string; due: string } | null>(null);
  const [noteText, setNoteText] = useState(''); const [noteEdit, setNoteEdit] = useState<{ id: string; body: string } | null>(null);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const edit = (fn: () => void) => { fn(); setDirty(true); setOk(undefined); };

  const mine = !!v && v.author_id === me.id;
  const validated = report?.status === 'validated';
  const notes = ((data?.notes ?? []) as R[]).filter(n => n.author_id === me.id);
  const notesText = notes.map(n => n.body).filter(Boolean).join('\n');
  const notesOpen = !!v && !['done', 'validated', 'cancelled', 'deleted'].includes(v.status);
  const actionsCount = ((data?.actions ?? []) as R[]).filter(a => a.status !== 'cancelled').length;
  const noActionAsked = drafts.length === 0 && actionsCount === 0;
  const inEnd = !!v && ['in_progress', 'done'].includes(v.status);
  const blockers = [
    !v || v.status !== 'done' ? "terminez le rendez-vous (« Fin du rendez-vous »)" : '', !(f.summary ?? '').trim() ? 'renseignez le résumé' : '', noActionAsked && !noAction ? 'ajoutez une action ou cochez « Aucune action à prévoir »' : '',
  ].filter(Boolean);
  const hasContent = Object.values(f).some(x => x.trim());

  const run = async (label: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(label); setErr(undefined); setOk(undefined);
    try { await fn(); if (success) setOk(success); reload(); onChanged(); } catch (e) { setErr(aiMessage(e)); } finally { setBusy(undefined); }
  };
  const language = (lang.data?.dictation_language as string | undefined) ?? 'fr';
  const fieldPayload = () => ({ ...Object.fromEntries(FIELDS.map(([k]) => [k, (f[k] ?? '').trim() || null])), opportunity_temperature: temp || null, draft_actions: drafts, no_action: noActionAsked && noAction });
  /** Enregistre le brouillon (création du compte rendu si nécessaire) ; renvoie l'identifiant du compte rendu. */
  const save = async (validate = false): Promise<string> => {
    if (!report) { const id = uid(); await pushOps([op('report', id, 'create', { visit_id: visitId, language, ...fieldPayload(), status: validate ? 'validated' : 'draft' })]); return id; }
    await pushOps([op('report', report.id, 'update', { ...fieldPayload(), ...(validate ? { status: 'validated' } : {}) }, report.version)]); return report.id as string;
  };
  const ensureSaved = async (): Promise<string> => { const id = await save(); setDirty(false); return id; };

  const generate = () => run('generate', async () => {
    const id = await ensureSaved();
    setProposal(await mobileApi<R>(`reports/${id}/ai-proposals`, { method: 'POST', body: { source_text: notesText, today: today() } }));
  });
  const applyProposal = () => {
    const p = proposal!.proposal as R;
    edit(() => {
      setF(cur => ({ ...cur, ...Object.fromEntries(Object.entries(p.fields as Record<string, string>).filter(([, x]) => x.trim())) }));       // un champ vide proposé n'efface rien
      setDrafts(cur => [...cur, ...(p.actions as R[]).map(a => ({ id: uid(), title: a.title as string, due_date: (a.due_date as string | null) ?? null, origin: 'ai' as const }))]);
    });
    setProposal(undefined);
  };
  const runReview = () => run('review', async () => {
    const id = await ensureSaved();
    setReview(await mobileApi<R>(`reports/${id}/ai-review`, { method: 'POST', body: {
      fields: Object.fromEntries(Object.entries(f).filter(([, x]) => x.trim())), temperature: temp || null, actions: drafts.map(d => ({ title: d.title, due_date: d.due_date })), no_action: noActionAsked && noAction, notes_text: notesText, today: today() } }));
  });
  const endVisit = () => run('end', () => pushOps([op('visit', visitId, 'update', { status: 'done', ended_at: new Date().toISOString() }, v!.version)]), 'Rendez-vous terminé.');
  const addNote = () => run('note', async () => { await pushOps([op('note', uid(), 'create', { visit_id: visitId, kind: 'text', body: noteText.trim(), noted_at: new Date().toISOString() })]); setNoteText(''); });
  const saveNote = () => run('note', async () => { await pushOps([op('note', noteEdit!.id, 'update', { body: noteEdit!.body.trim() })]); setNoteEdit(null); });
  const delNote = (id: string) => run('note', () => pushOps([op('note', id, 'delete', {})]));
  const reopen = () => run('reopen', async () => { await pushOps([op('report', report!.id, 'update', { status: 'draft' }, report!.version)]); setConfirmReopen(false); }, 'Compte rendu remis en brouillon.');

  const dictate = (k: string) => (text: string) => edit(() => setF(cur => ({ ...cur, [k]: cur[k]?.trim() ? `${cur[k]!.trimEnd()} ${text}` : text })));
  const field = (k: string) => (e: { target: { value: string } }) => edit(() => setF(cur => ({ ...cur, [k]: e.target.value })));
  const saveAction = () => {
    const a = actionEdit!; const due = a.due || null;
    edit(() => setDrafts(cur => a.index === null ? [...cur, { id: uid(), title: a.title.trim(), due_date: due, origin: 'manual' }] : cur.map((d, i) => i === a.index ? { ...d, title: a.title.trim(), due_date: due } : d)));
    setActionEdit(null);
  };

  const body = () => {
    if (!v) return null;
    if (!mine) return <Alert kind="warn">Seul l'auteur de la visite (« {v.author} ») rédige et valide le compte rendu.</Alert>;
    if (!inEnd && !validated) return <Alert kind="warn">Le compte rendu se rédige une fois la visite commencée (depuis l'application mobile : « Démarrer »). Statut actuel : {STATUS[v.status]}.</Alert>;
    return <div className="report-editor">
      {v.status === 'in_progress' && <Alert kind="warn">Rendez-vous en cours. <button className="link" disabled={!!busy} onClick={() => void endVisit()}>Fin du rendez-vous</button> pour pouvoir valider le compte rendu.</Alert>}
      <section><h3>Notes durant la visite ({notes.length})</h3>
        {notes.map(n => <div key={n.id} className="note-row">
          {noteEdit && noteEdit.id === n.id
            ? <><textarea rows={2} value={noteEdit.body} onChange={e => setNoteEdit({ id: n.id, body: e.target.value })} /><button className="primary" disabled={!noteEdit.body.trim() || !!busy} onClick={() => void saveNote()}>Enregistrer</button><button onClick={() => setNoteEdit(null)}>Annuler</button></>
            : <><span className="grow">{n.body}</span>{notesOpen && <><button onClick={() => setNoteEdit({ id: n.id, body: n.body ?? '' })} aria-label="Modifier la note">✎</button><button onClick={() => void delNote(n.id)} aria-label="Supprimer la note">✕</button></>}</>}
        </div>)}
        {notesOpen ? <div className="note-add"><textarea rows={2} placeholder="Ajouter une note…" value={noteText} onChange={e => setNoteText(e.target.value)} />
          <Mic visitId={visitId} id="note" label="Note" active={active} setActive={setActive} onText={t => setNoteText(c => (c.trim() ? `${c.trimEnd()} ${t}` : t))} onError={setErr} />
          <button disabled={!noteText.trim() || !!busy} onClick={() => void addNote()}>Ajouter</button></div> : <p className="muted">Les notes durant la visite sont figées une fois le rendez-vous terminé.</p>}
      </section>
      <section><h3>Compte rendu {validated ? <Badge tone="violet">Validé</Badge> : report ? <Badge tone="amber">Brouillon</Badge> : <Badge tone="grey">Non rédigé</Badge>}</h3>
        {validated && <Alert kind="ok">Compte rendu validé : les actions ont été créées. Remettez-le en brouillon pour le modifier{report?.sent_to_client_at ? ' (impossible : transmis au client)' : ''}.</Alert>}
        <div className="form one">
          {FIELDS.map(([k, label]) => <Field key={k} label={label}><div className="withmic"><textarea rows={k === 'summary' ? 4 : 2} aria-label={label} value={f[k] ?? ''} onChange={field(k)} disabled={validated} />
            {!validated && <Mic visitId={visitId} id={`f:${k}`} label={label} active={active} setActive={setActive} onText={dictate(k)} onError={setErr} />}</div></Field>)}
          <Field label="Opportunité"><select value={temp} onChange={e => edit(() => setTemp(e.target.value))} disabled={validated}><option value="">Non renseignée</option>{Object.entries(TEMP).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
      </section>
      <section><h3>{validated ? 'Actions' : 'Actions à créer à la validation'}</h3>
        {validated ? <p className="muted">{actionsCount} action{actionsCount > 1 ? 's' : ''} liée{actionsCount > 1 ? 's' : ''} à cette visite (voir le détail de la visite).</p> : <>
          {drafts.length === 0 && <p className="muted">Aucune action prévue. Elles ne deviennent de vraies actions qu'à la validation.</p>}
          {drafts.map((d, i) => <div key={d.id} className="note-row"><span className="grow">{d.title}<small className="muted"> · {d.due_date ? fmtDate(d.due_date) : 'sans échéance'}{d.origin === 'ai' ? " · proposée par l'IA" : ''}</small></span>
            <button aria-label={`Modifier l'action : ${d.title}`} onClick={() => setActionEdit({ index: i, title: d.title, due: d.due_date ?? '' })}>✎</button>
            <button aria-label={`Retirer l'action : ${d.title}`} onClick={() => edit(() => setDrafts(cur => cur.filter((_, j) => j !== i)))}>✕</button></div>)}
          <button onClick={() => setActionEdit({ index: null, title: '', due: '' })}>+ Ajouter une action</button>
          {noActionAsked && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={noAction} onChange={e => edit(() => setNoAction(e.target.checked))} /> Aucune action à prévoir</label>}
        </>}
      </section>
    </div>;
  };

  const footer = !v || !mine || (!inEnd && !validated) ? <button onClick={onClose}>Fermer</button> : validated
    ? <><button onClick={onClose}>Fermer</button><Tip why={report?.sent_to_client_at ? 'Compte rendu transmis au client : il ne peut plus être remis en brouillon.' : ''}><button disabled={!!report?.sent_to_client_at || !!busy} onClick={() => setConfirmReopen(true)}>Remettre en brouillon</button></Tip></>
    : <>
      <button onClick={onClose}>Fermer</button>
      <Tip why={!notesText.trim() ? 'Aucune note durant la visite à synthétiser.' : ''}><button disabled={!!busy || !notesText.trim() || !inEnd} onClick={() => void generate()}>{busy === 'generate' ? 'Génération…' : '✨ Générer (IA)'}</button></Tip>
      <Tip why={!hasContent && !notesText.trim() ? 'Rien à contrôler : le compte rendu est vide.' : ''}><button disabled={!!busy || (!hasContent && !notesText.trim())} onClick={() => void runReview()}>{busy === 'review' ? 'Contrôle…' : '🔎 Contrôler (IA)'}</button></Tip>
      <Tip why={!hasContent && !report ? 'Rien à enregistrer : le compte rendu est vide.' : !dirty ? 'Aucune modification.' : ''}><button disabled={!!busy || (!hasContent && !report) || !dirty} onClick={() => void run('save', async () => { await save(); }, 'Brouillon enregistré.')}>{busy === 'save' ? 'Enregistrement…' : 'Enregistrer'}</button></Tip>
      <Tip why={blockers.length ? `Pour valider : ${blockers.join(' ; ')}.` : ''}><button className="primary" disabled={!!busy || blockers.length > 0} onClick={() => void run('validate', async () => { await save(true); }, 'Compte rendu validé.')}>{busy === 'validate' ? 'Validation…' : 'Valider le compte rendu'}</button></Tip>
    </>;

  return (
    <>
      <Modal wide title={v ? `Compte rendu : ${v.company} — ${fmtDate(v.ended_at ?? v.started_at ?? v.planned_start)}` : 'Compte rendu'} onClose={onClose} footer={footer}>
        {(error || err) && <Alert>{err ?? error}</Alert>}{ok && <Alert kind="ok">{ok}</Alert>}{loading && !data && <Loading />}
        {v && <p className="muted"><Badge tone={STATUS_TONE[v.status]}>{STATUS[v.status]}</Badge> {v.planned_start ? `Prévue le ${fmtDateTime(v.planned_start)}` : ''}</p>}
        {body()}
      </Modal>
      {proposal && <Modal wide title="Proposition de l'IA" onClose={() => setProposal(undefined)} footer={<><button onClick={() => setProposal(undefined)}>Ignorer</button><button className="primary" onClick={applyProposal}>Appliquer au compte rendu</button></>}>
        <p className="muted">Relisez avant d'appliquer : un champ vide proposé n'efface rien, et les actions deviennent des actions <em>prévues</em> (créées à la validation).</p>
        {(proposal.warnings as string[]).length > 0 && <Alert kind="warn">{(proposal.warnings as string[]).map((w, i) => <div key={i}>{w}</div>)}</Alert>}
        <dl>{FIELDS.filter(([k]) => (proposal.proposal.fields as R)[k]).map(([k, l]) => <div key={k}><dt>{l}</dt><dd>{(proposal.proposal.fields as R)[k]}</dd></div>)}</dl>
        {(proposal.proposal.actions as R[]).length > 0 && <><h4>Actions proposées</h4><ul>{(proposal.proposal.actions as R[]).map((a, i) => <li key={i}>{a.title} <small className="muted">· {a.due_date ? `${fmtDate(a.due_date)}${a.due_date_certain ? '' : ' (calculée : à vérifier)'}` : 'sans échéance'}</small></li>)}</ul></>}
      </Modal>}
      {review && <Modal title="Contrôle du compte rendu" onClose={() => setReview(undefined)} footer={<button className="primary" onClick={() => setReview(undefined)}>Fermer et corriger</button>}>
        {(review.issues as R[]).length === 0 && <p className="muted">Aucune remarque : le compte rendu paraît cohérent.</p>}
        {(review.issues as R[]).map((i, k) => <div key={k} className={`issue ${i.severity}`}><small className="muted">{i.field === 'general' ? 'Général' : i.field === 'actions' ? 'Actions' : (FIELDS.find(([k2]) => k2 === i.field)?.[1] ?? i.field)} · {i.severity === 'warning' ? 'à corriger ?' : 'à considérer'}{i.source === 'ai' ? ' · IA' : ''}</small><div>{i.message}</div></div>)}
        {review.ai.status !== 'ok' && <p className="muted">{({ unavailable: 'Relecture IA non activée sur ce serveur : contrôles de base seulement.', skipped: "Rien à relire par l'IA : contrôles de base seulement.", rate_limited: "Trop de demandes d'IA : contrôles de base seulement.", quota: "Plafond mensuel d'IA atteint : contrôles de base seulement.", failed: 'La relecture IA a échoué : contrôles de base seulement.' } as Record<string, string>)[review.ai.status]}</p>}
        <p className="muted">Ces remarques sont des aides : elles ne bloquent pas la validation. L'IA peut se tromper.</p>
      </Modal>}
      {actionEdit && <Modal title={actionEdit.index === null ? 'Nouvelle action prévue' : "Modifier l'action prévue"} onClose={() => setActionEdit(null)} footer={<><button onClick={() => setActionEdit(null)}>Annuler</button><Tip why={!actionEdit.title.trim() ? 'Saisissez un intitulé.' : ''}><button className="primary" disabled={!actionEdit.title.trim()} onClick={saveAction}>Enregistrer</button></Tip></>}>
        <div className="form one"><Field label="Intitulé"><input value={actionEdit.title} maxLength={200} onChange={e => setActionEdit({ ...actionEdit, title: e.target.value })} autoFocus /></Field>
          <Field label="Échéance" hint="Facultatif. Créée à la validation du compte rendu."><input type="date" value={actionEdit.due} onChange={e => setActionEdit({ ...actionEdit, due: e.target.value })} /></Field></div>
      </Modal>}
      {confirmReopen && <Modal title="Remettre le compte rendu en brouillon ?" onClose={() => setConfirmReopen(false)} footer={<><button onClick={() => setConfirmReopen(false)}>Annuler</button><button className="primary" disabled={!!busy} onClick={() => void reopen()}>Remettre en brouillon</button></>}>
        <p>Le compte rendu redeviendra modifiable et la visite repassera à « Effectuée ». Les actions déjà créées sont conservées ; à la prochaine validation, seules les nouvelles actions prévues seront créées.</p>
      </Modal>}
    </>
  );
}
