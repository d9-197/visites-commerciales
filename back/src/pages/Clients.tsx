import { useState } from 'react';
import { api, type R } from '../api';
import { Alert, Badge, Card, Empty, Field, Loading, Modal, Why, useLoad, errMsg } from '../ui';

const PAGE = 50;
export function Clients() {
  const [q, setQ] = useState(''); const [status, setStatus] = useState('active'); const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useLoad(() => api<R>(`companies?limit=${PAGE}&offset=${offset}&q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`), [q, status, offset]);
  const [edit, setEdit] = useState<string | 'new' | null>(null); const [imp, setImp] = useState(false);
  return (
    <>
      <header className="page-head"><div><h1>Clients (maquette du CRM)</h1><p className="muted">Pour les essais : cette fenêtre tient lieu de CRM. Les clients, contacts et affectations saisis ici sont synchronisés vers les applications mobiles comme le ferait le CRM.</p></div>
        <div className="toolbar"><button onClick={() => setImp(true)}>Importer un CSV</button><button className="primary" onClick={() => setEdit('new')}>+ Nouveau client</button></div></header>
      <Card>
        <div className="toolbar filters">
          <input type="search" placeholder="Nom, ville, identifiant CRM…" aria-label="Rechercher un client" value={q} onChange={e => { setQ(e.target.value); setOffset(0); }} />
          <select aria-label="Statut" value={status} onChange={e => { setStatus(e.target.value); setOffset(0); }}><option value="active">Actifs</option><option value="inactive">Inactifs</option><option value="">Tous</option></select>
        </div>
        {error && <Alert>{error}</Alert>}{loading && !data && <Loading />}
        {data && (data.companies.length === 0 ? <Empty>Aucun client. Créez-en un ou importez un fichier CSV.</Empty> : <>
          <div className="scroll"><table className="clickable"><thead><tr><th>Client</th><th>Identifiant CRM</th><th>Ville</th><th>Commerciaux</th><th>Contacts</th><th>Visites</th><th>Statut</th></tr></thead><tbody>
            {data.companies.map((c: R) => <tr key={c.id} tabIndex={0} onClick={() => setEdit(c.id)} onKeyDown={e => { if (e.key === 'Enter') setEdit(c.id); }}>
              <td><strong>{c.name}</strong></td><td><code>{c.crm_id}</code></td><td>{c.city ?? '—'}</td><td>{c.assigned.map((a: R) => a.name).join(', ') || <span className="muted">Aucun</span>}</td><td>{c.contacts_count}</td><td>{c.visits_count}</td>
              <td><Badge tone={c.status === 'active' ? 'green' : 'grey'}>{c.status === 'active' ? 'Actif' : 'Inactif'}</Badge></td></tr>)}
          </tbody></table></div>
          <div className="pager"><span className="muted">{offset + 1}–{offset + data.companies.length} sur {data.total}</span>
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹ Précédents</button><button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Suivants ›</button></div></>)}
      </Card>
      {edit && <CompanyModal id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onChanged={reload} />}
      {imp && <ImportModal onClose={() => setImp(false)} onDone={() => { reload(); }} />}
    </>
  );
}

function CompanyModal({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [cid, setCid] = useState<string | null>(id);
  const detail = useLoad(() => (cid ? api<R>(`companies/${cid}`) : Promise.resolve(null)), [cid]);
  const users = useLoad(() => api<R>('users'), []);
  const d = detail.data;
  const [f, setF] = useState<R | null>(null);
  const form = f ?? (d ? { ...d.company } : { name: '', address_line: '', postal_code: '', city: '', country: '', sector: '', status: 'active' });
  const set = (k: string, v: unknown) => setF({ ...form, [k]: v });
  const [err, setErr] = useState<string>(); const [ok, setOk] = useState<string>(); const [busy, setBusy] = useState(false);
  const fields = (x: R) => ({ name: x.name?.trim(), address_line: x.address_line || null, postal_code: x.postal_code || null, city: x.city || null, country: x.country || null, sector: x.sector || null });
  const guard = async (fn: () => Promise<void>, done?: string) => { setBusy(true); setErr(undefined); setOk(undefined); try { await fn(); if (done) setOk(done); onChanged(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const save = () => guard(async () => {
    if (cid) await api(`companies/${cid}`, { method: 'PATCH', body: { ...fields(form), status: form.status } });
    else { const r = await api<R>('companies', { method: 'POST', body: fields(form) }); setCid(r.id); setF(null); }
    detail.reload();
  }, 'Enregistré.');
  const commerciaux = (users.data?.users ?? []).filter((u: R) => u.role === 'commercial' && u.status === 'active');
  const assigned = new Set<string>((d?.company.assigned ?? []).map((a: R) => a.id));
  const toggle = (uid: string) => guard(async () => { const s = new Set(assigned); if (s.has(uid)) s.delete(uid); else s.add(uid); await api(`companies/${cid}/assignments`, { method: 'PUT', body: { user_ids: [...s] } }); detail.reload(); });
  return (
    <Modal wide title={cid ? (d?.company.name ?? 'Client') : 'Nouveau client'} onClose={onClose} footer={<><button onClick={onClose}>Fermer</button><button className="primary" disabled={busy || !form.name?.trim()} onClick={() => void save()}>Enregistrer</button></>}>
      <div className="fiche">
        <section><h3>Informations</h3><div className="form one">
          <Field label="Nom"><input value={form.name ?? ''} onChange={e => set('name', e.target.value)} autoFocus /></Field>
          <Field label="Adresse"><input value={form.address_line ?? ''} onChange={e => set('address_line', e.target.value)} /></Field>
          <div className="row2"><Field label="Code postal"><input value={form.postal_code ?? ''} onChange={e => set('postal_code', e.target.value)} /></Field><Field label="Ville"><input value={form.city ?? ''} onChange={e => set('city', e.target.value)} /></Field></div>
          <div className="row2"><Field label="Pays"><input value={form.country ?? ''} onChange={e => set('country', e.target.value)} /></Field><Field label="Secteur"><input value={form.sector ?? ''} onChange={e => set('sector', e.target.value)} /></Field></div>
          {cid && <Field label="Statut"><select value={form.status} onChange={e => set('status', e.target.value)}><option value="active">Actif</option><option value="inactive">Inactif (n'apparaît plus dans les applications)</option></select></Field>}
        </div>
          {err && <Alert>{err}</Alert>}{ok && <Alert kind="ok">{ok}</Alert>}
          <Why>{!form.name?.trim() ? 'Renseignez le nom du client pour enregistrer.' : ''}</Why>
        </section>
        {cid && d ? <>
          <section><h3>Commerciaux affectés</h3><p className="muted">Un commercial voit le client (et ses managers avec lui) dès qu'il lui est affecté.</p>
            <ul className="checks">{commerciaux.map((u: R) => <li key={u.id}><label><input type="checkbox" checked={assigned.has(u.id)} disabled={busy} onChange={() => void toggle(u.id)} /> {u.display_name}</label></li>)}</ul>
            {commerciaux.length === 0 && <p className="muted">Aucun commercial actif.</p>}</section>
          <Contacts companyId={cid} contacts={d.contacts} onChange={() => { detail.reload(); onChanged(); }} />
        </> : <section><p className="muted">Enregistrez le client pour affecter des commerciaux et ajouter des contacts.</p></section>}
      </div>
    </Modal>
  );
}

function Contacts({ companyId, contacts, onChange }: { companyId: string; contacts: R[]; onChange: () => void }) {
  const [edit, setEdit] = useState<R | null>(null); const [err, setErr] = useState<string>();
  const save = async () => {
    setErr(undefined);
    const body = { full_name: edit!.full_name?.trim(), job_title: edit!.job_title || null, phone: edit!.phone || null, email: edit!.email || null };
    try { if (edit!.id) await api(`contacts/${edit!.id}`, { method: 'PATCH', body }); else await api(`companies/${companyId}/contacts`, { method: 'POST', body }); setEdit(null); onChange(); } catch (e) { setErr(errMsg(e)); }
  };
  return (
    <section className="full"><h3>Contacts <button className="link" onClick={() => setEdit({ full_name: '', job_title: '', phone: '', email: '' })}>+ Ajouter</button></h3>
      {contacts.length === 0 && !edit && <p className="muted">Aucun contact.</p>}
      {contacts.length > 0 && <table><thead><tr><th>Nom</th><th>Fonction</th><th>Téléphone</th><th>E-mail</th><th /></tr></thead><tbody>
        {contacts.map(c => <tr key={c.id}><td>{c.full_name}</td><td>{c.job_title ?? '—'}</td><td>{c.phone ?? '—'}</td><td>{c.email ?? '—'}</td>
          <td className="actions"><button onClick={() => setEdit(c)}>Modifier</button><button onClick={() => void api(`contacts/${c.id}`, { method: 'DELETE' }).then(onChange).catch(e => setErr(errMsg(e)))}>Supprimer</button></td></tr>)}</tbody></table>}
      {edit && <div className="inline-form form">
        <Field label="Nom"><input value={edit.full_name} onChange={e => setEdit({ ...edit, full_name: e.target.value })} autoFocus /></Field>
        <Field label="Fonction"><input value={edit.job_title ?? ''} onChange={e => setEdit({ ...edit, job_title: e.target.value })} /></Field>
        <Field label="Téléphone"><input value={edit.phone ?? ''} onChange={e => setEdit({ ...edit, phone: e.target.value })} /></Field>
        <Field label="E-mail"><input type="email" value={edit.email ?? ''} onChange={e => setEdit({ ...edit, email: e.target.value })} /></Field>
        <div className="full toolbar"><button onClick={() => setEdit(null)}>Annuler</button><button className="primary" disabled={!edit.full_name?.trim()} onClick={() => void save()}>Enregistrer le contact</button></div>
        <div className="full"><Why>{!edit.full_name?.trim() ? 'Renseignez le nom du contact pour enregistrer.' : ''}</Why></div></div>}
      {err && <Alert>{err}</Alert>}
    </section>
  );
}

const TEMPLATE_COMPANIES = 'crm_id;name;address_line;postal_code;city;country;sector;sales_emails\nC-001;Boulangerie Martin;12 rue des Lilas;69003;Lyon;France;Agroalimentaire;commercial1@exemple.invalid\n';
const TEMPLATE_CONTACTS = 'company_crm_id;crm_id;full_name;job_title;phone;email\nC-001;CT-001;Marie Martin;Gérante;04 72 00 00 00;marie@martin.example\n';
const dataUrl = (s: string) => `data:text/csv;charset=utf-8,${encodeURIComponent('﻿' + s)}`;

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [companies, setCompanies] = useState<{ name: string; text: string } | null>(null); const [contacts, setContacts] = useState<{ name: string; text: string } | null>(null);
  const [res, setRes] = useState<R | null>(null); const [errs, setErrs] = useState<R[]>([]); const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const read = async (e: React.ChangeEvent<HTMLInputElement>, set: (x: { name: string; text: string } | null) => void) => { const f = e.target.files?.[0]; set(f ? { name: f.name, text: await f.text() } : null); setRes(null); setErrs([]); setErr(undefined); };
  const run = async (dry: boolean) => {
    setBusy(true); setErr(undefined); setErrs([]);
    try { const r = await api<R>('import', { method: 'POST', body: { companies_csv: companies?.text, contacts_csv: contacts?.text, dry_run: dry } }); setRes(r); if (!dry) onDone(); }
    catch (e: any) { setErr(errMsg(e)); setErrs(e.extra?.errors ?? []); setRes(null); } finally { setBusy(false); }
  };
  const ready = !!(companies || contacts);
  return (
    <Modal wide title="Importer des clients et contacts (CSV)" onClose={onClose} footer={<><button onClick={onClose}>Fermer</button><button disabled={!ready || busy} onClick={() => void run(true)}>Vérifier</button><button className="primary" disabled={!ready || busy || !res || res.dry_run === false} onClick={() => void run(false)}>Importer</button></>}>
      <p className="muted">Séparateur « ; » ou « , », encodage UTF-8. Un client déjà connu (même identifiant CRM) est mis à jour ; ses commerciaux (colonne <code>sales_emails</code>) remplacent les affectations issues du CRM. Les erreurs de format bloquent tout l'import. Modèles : <a download="clients.csv" href={dataUrl(TEMPLATE_COMPANIES)}>clients.csv</a> · <a download="contacts.csv" href={dataUrl(TEMPLATE_CONTACTS)}>contacts.csv</a></p>
      <div className="form">
        <Field label="Fichier des clients"><input type="file" accept=".csv,text/csv" onChange={e => void read(e, setCompanies)} /></Field>
        <Field label="Fichier des contacts (facultatif)"><input type="file" accept=".csv,text/csv" onChange={e => void read(e, setContacts)} /></Field>
      </div>
      {err && <Alert>{err}</Alert>}
      {errs.length > 0 && <table><thead><tr><th>Fichier</th><th>Ligne</th><th>Problème</th></tr></thead><tbody>{errs.map((e, i) => <tr key={i}><td>{e.file}</td><td>{e.line}</td><td>{e.message}</td></tr>)}</tbody></table>}
      <Why>{!ready ? 'Choisissez au moins un fichier CSV.' : !res && !err ? 'Cliquez d\'abord sur « Vérifier » : l\'import n\'est possible qu\'après une vérification réussie.' : err ? 'Corrigez le fichier puis vérifiez à nouveau : l\'import est bloqué tant que la vérification échoue.' : ''}</Why>
      {res && !err && <Alert kind="ok">{res.dry_run ? 'Vérification réussie' : 'Import terminé'} : {res.companies} client(s), {res.contacts} contact(s){res.dry_run ? '. Cliquez sur « Importer » pour enregistrer.' : '.'}</Alert>}
      {(res?.warnings?.length ?? 0) > 0 && <Alert kind="warn"><strong>Avertissements :</strong><ul>{res!.warnings.slice(0, 20).map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></Alert>}
    </Modal>
  );
}
