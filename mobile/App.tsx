import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ApiClient, SyncEngine, uuidv4, type Row, type SyncReport } from '@visites/sync-core';
import type { SqliteStore } from '@visites/sync-core';
import { openStore } from './src/expoDb';
import { clearSession, loadSession, saveSession, saveTokens, type Session, type ThemePref } from './src/session';
import { ThemeProvider, useTheme } from './src/theme';
import { fmtDateTime, fromLocalInputs, toLocalInputs, visitWhen, VISIT_STATUS } from './src/dates';

// Prototype : écrans minimaux pour exercer la synchro. La dictée vocale et l'IA ne sont PAS implémentées.
const APP_VERSION = '0.1.0';
// Web : même adresse que la page. Mobile natif : à saisir (10.0.2.2 = machine hôte depuis l'émulateur Android).
const DEFAULT_SERVER = Platform.OS === 'web' ? '/api/mobile/v1' : 'http://10.0.2.2:3000/api/mobile/v1';
const PLATFORM: 'ios' | 'android' | 'web' = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'web' ? 'web' : 'android';

type Screen = { name: 'today' } | { name: 'visit'; id: string } | { name: 'clients' } | { name: 'actions' } | { name: 'action'; id?: string } | { name: 'settings' };
interface Data { visits: Row[]; companies: Row[]; actions: Row[]; reports: Row[]; notes: Row[]; pending: number }
interface Ctx { store: SqliteStore; engine: SyncEngine; client: ApiClient; userId: string }
type Act = (f: () => Promise<unknown>) => Promise<void>;

export default function App() {
  return <ThemeProvider><Root /></ThemeProvider>;
}

function Root() {
  const { s } = useTheme();
  const [boot, setBoot] = useState<'loading' | 'login' | 'ready'>('loading');
  const [ctx, setCtx] = useState<Ctx>();
  const storeRef = useRef<SqliteStore>();

  const start = useCallback(async (sess: Session, onTokens: (t: Session['tokens'] | undefined) => void) => {
    storeRef.current ??= await openStore();
    const store = storeRef.current;
    const client = new ApiClient(sess.server, APP_VERSION, sess.tokens, t => { void saveTokens(t); onTokens(t); });
    const engine = new SyncEngine(store, client, { newId: uuidv4, userId: sess.userId });
    setCtx({ store, engine, client, userId: sess.userId });
    setBoot('ready');
  }, []);

  useEffect(() => { (async () => {
    const sess = await loadSession();
    if (!sess) return setBoot('login');
    await start(sess, t => { if (!t) setBoot('login'); });
  })().catch(() => setBoot('login')); }, [start]);

  const logout = useCallback(async () => {
    try { await ctx?.client['call']('POST', '/auth/logout'); } catch { /* hors-ligne : la révocation côté serveur aura lieu plus tard */ }
    await storeRef.current?.wipe();    // plus aucune donnée sur l'appareil
    await clearSession(); setCtx(undefined); setBoot('login');
  }, [ctx]);

  if (boot === 'loading') return <View style={[s.page, { alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator /></View>;
  if (boot === 'login' || !ctx) return <Login onDone={async sess => { await saveSession(sess); await start(sess, () => {}); }} />;
  return <Main ctx={ctx} onLogout={logout} />;
}

function Login({ onDone }: { onDone: (s: Session) => Promise<void> }) {
  const { s, c, dark } = useTheme();
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(undefined);
    try {
      const client = new ApiClient(server, APP_VERSION, undefined);
      const tokens = await client.login(email.trim(), password, PLATFORM);
      const me = await client.me();
      await onDone({ server, userId: me.id, tokens });
    } catch (e: any) {
      setErr(e.code === 'invalid_credentials' ? 'Identifiants incorrects.' : e.code === 'account_locked' ? 'Compte verrouillé, réessayez plus tard.'
        : e.code === 'upgrade_required' ? 'Mettez l\'application à jour.' : 'Connexion impossible. Vérifiez le réseau et l\'adresse du serveur.');
    } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={s.page}><StatusBar style={dark ? 'light' : 'dark'} /><View style={s.pad}>
      <Text style={s.h1}>Visites commerciales</Text>
      <Label>Adresse du serveur</Label><TextInput accessibilityLabel="Adresse du serveur" placeholderTextColor={c.muted} style={s.input} value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} />
      <Label>E-mail</Label><TextInput accessibilityLabel="E-mail" placeholderTextColor={c.muted} style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      <Label>Mot de passe</Label><TextInput accessibilityLabel="Mot de passe" placeholderTextColor={c.muted} style={s.input} value={password} onChangeText={setPassword} secureTextEntry />
      {err ? <Text style={s.err}>{err}</Text> : null}
      <Btn title={busy ? 'Connexion…' : 'Se connecter'} onPress={submit} disabled={busy || !email || !password} />
    </View></SafeAreaView>
  );
}

function Main({ ctx, onLogout }: { ctx: Ctx; onLogout: () => void }) {
  const { s, dark, pref, setPref } = useTheme();
  const [screen, setScreen] = useState<Screen>({ name: 'today' });
  const [group, setGroup] = useState<'client' | 'date'>('client');
  const [data, setData] = useState<Data>({ visits: [], companies: [], actions: [], reports: [], notes: [], pending: 0 });
  const [status, setStatus] = useState<{ offline: boolean; msg?: string }>({ offline: false });
  const syncing = useRef(false);

  const load = useCallback(async () => {
    const { store } = ctx;
    setData({
      visits: await store.list('visits'), companies: await store.list('companies'), actions: await store.list('actions'),
      reports: await store.list('reports'), notes: await store.list('notes'), pending: await store.pendingCount(),
    });
  }, [ctx]);

  const sync = useCallback(async () => {
    if (syncing.current) return; syncing.current = true;
    try {
      const r: SyncReport = await ctx.engine.sync();
      const issues = r.conflicts.length + r.rejected.length;
      setStatus({ offline: r.offline, msg: issues ? `${r.conflicts.length} conflit(s), ${r.rejected.length} refus` : undefined });
    } catch (e: any) { setStatus({ offline: false, msg: e.code === 'session_expired' ? 'Session expirée' : 'Erreur de synchronisation' }); }
    finally { syncing.current = false; await load(); }
  }, [ctx, load]);

  useEffect(() => { void load(); void sync(); const t = setInterval(() => void sync(), 60_000);
    const sub = AppState.addEventListener('change', st => { if (st === 'active') void sync(); });
    return () => { clearInterval(t); sub.remove(); }; }, [load, sync]);

  const act: Act = async fn => { await fn(); await load(); void sync(); };
  const companyName = (id: string) => data.companies.find(c => c.id === id)?.name ?? '…';
  // Plus récente d'abord ; les visites sans date prévue en dernier.
  const byDateDesc = (a: Row, b: Row) => String(b.planned_start ?? '').localeCompare(String(a.planned_start ?? ''));

  const groups = (() => {
    const m = new Map<string, Row[]>();
    for (const v of data.visits) m.set(v.company_id, [...(m.get(v.company_id) ?? []), v]);
    return [...m.entries()].map(([id, vs]) => ({ id, name: companyName(id), visits: vs.sort(byDateDesc) })).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  })();

  const themeLabels: [ThemePref, string][] = [['system', 'Système'], ['light', 'Clair'], ['dark', 'Sombre']];

  return (
    <SafeAreaView style={s.page}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <View style={[s.bar, status.offline && s.barOff]}>
        <Text style={s.barText}>{status.offline ? 'Hors-ligne' : 'Synchronisé'}{data.pending ? ` · ${data.pending} en attente` : ''}{status.msg ? ` · ${status.msg}` : ''}</Text>
        <Pressable onPress={() => void sync()} accessibilityRole="button"><Text style={s.link}>Synchroniser</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={s.pad}>
        {screen.name === 'today' && <>
          <Text style={s.h1}>Visites</Text>
          <Seg value={group} onChange={setGroup} options={[['client', 'Par client'], ['date', 'Par date']]} />
          {data.visits.length === 0 && <Text style={s.muted}>Aucune visite. Créez-en une depuis l'onglet Clients.</Text>}
          {group === 'client'
            ? groups.map(g => (
              <View key={g.id} style={{ gap: 8 }}>
                <View style={s.group}><Text accessibilityRole="header" style={s.h2}>{g.name}</Text><Text style={s.muted}>{g.visits.length} visite{g.visits.length > 1 ? 's' : ''}</Text></View>
                {g.visits.map(v => <VisitRow key={v.id} v={v} onPress={() => setScreen({ name: 'visit', id: v.id })} />)}
              </View>))
            : [...data.visits].sort(byDateDesc).map(v => <VisitRow key={v.id} v={v} client={companyName(v.company_id)} onPress={() => setScreen({ name: 'visit', id: v.id })} />)}
        </>}
        {screen.name === 'clients' && <>
          <Text style={s.h1}>Clients</Text>
          <Text style={s.muted}>Source : CRM, lecture seule. Toucher un client crée une visite.</Text>
          {data.companies.filter(c => c.status === 'active').map(c => (
            <Row key={c.id} title={c.name} sub={[c.city, c.sector].filter(Boolean).join(' · ')}
              onPress={() => act(async () => { const id = await ctx.engine.create('visit', { company_id: c.id, status: 'planned', planned_start: new Date().toISOString() }); setScreen({ name: 'visit', id }); })} />
          ))}
        </>}
        {screen.name === 'visit' && <VisitScreen key={screen.id} visitId={screen.id} data={data} ctx={ctx} act={act} back={() => setScreen({ name: 'today' })} companyName={companyName} />}
        {screen.name === 'actions' && <>
          <View style={s.rowBetween}><Text style={s.h1}>Actions</Text><Btn small title="+ Nouvelle" onPress={() => setScreen({ name: 'action' })} /></View>
          {[...data.actions].sort((a, b) => String(a.due_date ?? '9').localeCompare(String(b.due_date ?? '9'))).map(a => (
            <View key={a.id} style={s.rowCard}>
              <Pressable onPress={() => act(() => ctx.engine.update('action', a.id, { status: a.status === 'done' ? 'todo' : 'done' }))} accessibilityRole="checkbox" accessibilityState={{ checked: a.status === 'done' }} style={[s.box, a.status === 'done' && s.boxOn]} />
              <Pressable style={{ flex: 1 }} onPress={() => setScreen({ name: 'action', id: a.id })}>
                <Text style={[s.t, a.status !== 'todo' && s.done]}>{a.title}</Text>
                <Text style={s.muted}>{companyName(a.company_id)} · {a.due_date ?? 'sans échéance'}{a.status === 'cancelled' ? ' · annulée' : ''}</Text>
              </Pressable>
            </View>
          ))}
        </>}
        {screen.name === 'action' && <ActionForm key={screen.id ?? 'new'} id={screen.id} data={data} ctx={ctx} act={act} back={() => setScreen({ name: 'actions' })} />}
        {screen.name === 'settings' && <>
          <Text style={s.h1}>Réglages</Text>
          <Label>Affichage</Label>
          <Seg value={pref} onChange={setPref} options={themeLabels} />
          <Text style={s.muted}>« Système » suit le réglage de votre téléphone.</Text>
          <Text style={s.muted}>Version {APP_VERSION}. Dictée, IA et chiffrement de la base : non implémentés dans ce prototype.</Text>
          <Btn title="Se déconnecter (efface les données de l'appareil)" onPress={onLogout} />
        </>}
      </ScrollView>
      <View style={s.tabs}>
        {([['today', 'Visites'], ['clients', 'Clients'], ['actions', 'Actions'], ['settings', 'Réglages']] as const).map(([k, l]) => (
          <Pressable key={k} style={s.tab} onPress={() => setScreen({ name: k } as Screen)} accessibilityRole="button"><Text style={[s.tabText, screen.name === k && s.tabOn]}>{l}</Text></Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

function VisitRow({ v, client, onPress }: { v: Row; client?: string; onPress: () => void }) {
  const w = visitWhen(v);
  // Par client : la date est le titre. Par date : le client est le titre, la date en dessous.
  return <Row onPress={onPress} title={client ?? w.main} sub={client ? `${w.main} · ${VISIT_STATUS[v.status] ?? v.status}` : (w.sub ? `${w.sub}${v.objective ? ' · ' + v.objective : ''}` : v.objective ?? undefined)} badge={client ? undefined : VISIT_STATUS[v.status]} />;
}

function VisitScreen({ visitId, data, ctx, act, back, companyName }: { visitId: string; data: Data; ctx: Ctx; act: Act; back: () => void; companyName: (id: string) => string }) {
  const { s, c } = useTheme();
  const v: Row | undefined = data.visits.find(x => x.id === visitId);
  const report: Row | undefined = data.reports.find(r => r.visit_id === visitId);
  const [summary, setSummary] = useState<string>(report?.summary ?? '');
  const [note, setNote] = useState('');
  const [pd, setPd] = useState(''); const [pt, setPt] = useState('');
  // Les champs suivent la date prévue de la visite : à l'ouverture (la visite peut arriver après l'affichage) et si elle change ailleurs.
  const planned: string | undefined = v?.planned_start ?? undefined;
  useEffect(() => { const i = toLocalInputs(planned); setPd(i.date); setPt(i.time); }, [planned]);
  if (!v) return <><Btn small title="‹ Retour" onPress={back} /><Text style={s.muted}>Visite introuvable (supprimée ou plus accessible).</Text></>;
  const mine = v.author_id === ctx.userId;
  const newPlanned = fromLocalInputs(pd, pt);
  const saveReport = (validate: boolean) => act(async () => {
    const st = validate ? 'validated' : 'draft';
    if (!report) await ctx.engine.create('report', { visit_id: visitId, language: 'fr', summary, status: st });
    else await ctx.engine.update('report', report.id, { summary, ...(validate ? { status: st } : {}) });
  });
  const Fact = ({ k, val }: { k: string; val: string }) => <View style={s.fact}><Text style={s.muted}>{k}</Text><Text style={[s.t, { flexShrink: 1, textAlign: 'right' }]}>{val}</Text></View>;
  return <>
    <Btn small title="‹ Retour" onPress={back} />
    <Text style={s.h1}>{companyName(v.company_id)}</Text>
    <View style={[s.rowCard, { flexDirection: 'column', alignItems: 'stretch', gap: 6 }]}>
      <Fact k="Statut" val={VISIT_STATUS[v.status] ?? v.status} />
      <Fact k="Prévue" val={v.planned_start ? fmtDateTime(v.planned_start) : 'non planifiée'} />
      <Fact k="Commencée" val={v.started_at ? fmtDateTime(v.started_at) : '—'} />
      <Fact k="Terminée" val={v.ended_at ? fmtDateTime(v.ended_at) : '—'} />
    </View>
    {mine && v.status !== 'done' && v.status !== 'cancelled' && <>
      <Label>Modifier la date prévue</Label>
      <View style={s.rowBetween}>
        <TextInput accessibilityLabel="Date prévue (AAAA-MM-JJ)" placeholderTextColor={c.muted} style={[s.input, { flex: 2, minWidth: 0 }]} value={pd} onChangeText={setPd} placeholder="AAAA-MM-JJ" autoCapitalize="none" />
        <TextInput accessibilityLabel="Heure prévue (HH:MM)" placeholderTextColor={c.muted} style={[s.input, { flex: 1, minWidth: 0 }]} value={pt} onChangeText={setPt} placeholder="HH:MM" autoCapitalize="none" />
      </View>
      <Btn small title="Enregistrer la date" disabled={!newPlanned} onPress={() => act(() => ctx.engine.update('visit', v.id, { planned_start: newPlanned }))} />
    </>}
    {mine && <View style={s.rowBetween}>
      {v.status === 'planned' && <Btn title="Démarrer" onPress={() => act(() => ctx.engine.update('visit', v.id, { status: 'in_progress', started_at: new Date().toISOString() }))} />}
      {v.status === 'in_progress' && <Btn title="Terminer" onPress={() => act(() => ctx.engine.update('visit', v.id, { status: 'done', ended_at: new Date().toISOString() }))} />}
    </View>}
    <Label>Notes</Label>
    {data.notes.filter(n => n.visit_id === visitId).map(n => <Text key={n.id} style={s.note}>{n.body}</Text>)}
    {mine && <><TextInput accessibilityLabel="Nouvelle note" placeholderTextColor={c.muted} style={s.input} value={note} onChangeText={setNote} placeholder="Nouvelle note" multiline />
      <Btn small title="Ajouter" disabled={!note.trim()} onPress={() => act(async () => { await ctx.engine.create('note', { visit_id: visitId, kind: 'text', body: note.trim() }); setNote(''); })} /></>}
    <Label>Compte rendu {report?.status === 'validated' ? '(validé)' : ''}</Label>
    <TextInput accessibilityLabel="Résumé du compte rendu" placeholderTextColor={c.muted} style={[s.input, { minHeight: 110 }]} value={summary} onChangeText={setSummary} multiline editable={mine} placeholder="Résumé de la visite" />
    <Text style={s.muted}>Saisie manuelle. La dictée vocale et l'IA ne sont pas disponibles dans ce prototype.</Text>
    {mine && <View style={s.rowBetween}>
      <Btn small title="Enregistrer" onPress={() => saveReport(false)} />
      <Btn small title="Valider" disabled={!summary.trim() || report?.status === 'validated'} onPress={() => saveReport(true)} />
    </View>}
  </>;
}

function ActionForm({ id, data, ctx, act, back }: { id?: string; data: Data; ctx: Ctx; act: Act; back: () => void }) {
  const { s, c } = useTheme();
  const existing: Row | undefined = id ? data.actions.find(a => a.id === id) : undefined;
  const [title, setTitle] = useState(existing?.title ?? ''); const [due, setDue] = useState(existing?.due_date ?? '');
  const [company, setCompany] = useState<string>(existing?.company_id ?? data.companies[0]?.id ?? '');
  const valid = title.trim().length > 0 && (!due || /^\d{4}-\d{2}-\d{2}$/.test(due)) && !!company;
  return <>
    <Btn small title="‹ Retour" onPress={back} />
    <Text style={s.h1}>{existing ? 'Modifier l\'action' : 'Nouvelle action'}</Text>
    <Label>Intitulé</Label><TextInput accessibilityLabel="Intitulé de l'action" placeholderTextColor={c.muted} style={s.input} value={title} onChangeText={setTitle} />
    <Label>Client</Label>
    {data.companies.map(co => <Pressable key={co.id} onPress={() => !existing && setCompany(co.id)} style={[s.choice, company === co.id && s.choiceOn]}><Text style={{ color: c.text }}>{co.name}</Text></Pressable>)}
    <Label>Échéance (AAAA-MM-JJ)</Label><TextInput accessibilityLabel="Échéance" placeholderTextColor={c.muted} style={s.input} value={due} onChangeText={setDue} placeholder="2026-11-26" autoCapitalize="none" />
    <Text style={s.muted}>Responsable : vous.</Text>
    <Btn title="Enregistrer" disabled={!valid} onPress={() => act(async () => {
      if (existing) await ctx.engine.update('action', existing.id, { title: title.trim(), due_date: due || null });
      else await ctx.engine.create('action', { company_id: company, title: title.trim(), ...(due ? { due_date: due } : {}), origin: 'manual' });
      back();
    })} />
    {existing && existing.status !== 'cancelled' && <Btn title="Annuler l'action" onPress={() => act(async () => { await ctx.engine.update('action', existing.id, { status: 'cancelled' }); back(); })} />}
  </>;
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  const { s } = useTheme();
  return <View style={s.seg} accessibilityRole="radiogroup">{options.map(([k, l]) => (
    <Pressable key={k} accessibilityRole="radio" accessibilityState={{ selected: value === k }} onPress={() => onChange(k)} style={[s.segBtn, value === k && s.segOn]}>
      <Text style={[s.segText, value === k && s.segTextOn]}>{l}</Text></Pressable>))}</View>;
}
const Label = ({ children }: { children: React.ReactNode }) => { const { s } = useTheme(); return <Text style={s.label}>{children}</Text>; };
const Btn = ({ title, onPress, disabled, small }: { title: string; onPress: () => void; disabled?: boolean; small?: boolean }) => {
  const { s } = useTheme();
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={[s.btn, small && s.btnSmall, disabled && s.btnOff]}><Text style={s.btnText}>{title}</Text></Pressable>;
};
const Row = ({ title, sub, badge, onPress }: { title: string; sub?: string; badge?: string; onPress: () => void }) => {
  const { s } = useTheme();
  return <Pressable onPress={onPress} style={s.rowCard} accessibilityRole="button"><View style={{ flex: 1 }}><Text style={s.t}>{title}</Text>{sub ? <Text style={s.muted}>{sub}</Text> : null}</View>{badge ? <Text style={s.muted}>{badge}</Text> : null}<Text style={s.muted}>›</Text></Pressable>;
};
