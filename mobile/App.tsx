import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Platform, Pressable, SafeAreaView, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ApiClient, ApiError, NetworkError, SyncEngine, uuidv4, type AiProposalResponse, type Row, type SyncReport } from '@visites/sync-core';
import type { SqliteStore } from '@visites/sync-core';
import { openStore } from './src/expoDb';
import { clearSession, loadSession, saveSession, saveTokens, type Session, type ThemePref } from './src/session';
import { ThemeProvider, useTheme, visitStatusColor } from './src/theme';
import { canEditVisitAddress, canEditVisitDate, isActionLate, isVisitLate, type UserRole } from '@visites/sync-core';
import { ceilTo15, dateToStr, fmtDate, fmtDateTime, strToDate, visitWhen, VISIT_STATUS } from './src/dates';
import { Sheet } from './src/Sheet';
import { DateField } from './src/DateField';
import { NavChooser } from './src/NavChooser';
import { createRecorder, RecorderError, type Recorder, type RecordedAudio } from './src/recorder';
import { AudioFilePicker } from './src/AudioFilePicker';
import { companyAddress } from './src/nav';

// Prototype : écrans minimaux pour exercer la synchro. La dictée vocale et l'IA ne sont PAS implémentées.
const APP_VERSION = '0.1.0';
// Web : même adresse que la page. Mobile natif : à saisir (10.0.2.2 = machine hôte depuis l'émulateur Android).
// Sous un sous-chemin (https://exemple.fr/visit), le back transmet le préfixe dans window.__BASE_PATH__.
const WEB_BASE = Platform.OS === 'web' ? ((globalThis as { __BASE_PATH__?: string }).__BASE_PATH__ ?? '') : '';
const DEFAULT_SERVER = Platform.OS === 'web' ? `${WEB_BASE}/api/mobile/v1` : 'http://10.0.2.2:3000/api/mobile/v1';
const PLATFORM: 'ios' | 'android' | 'web' = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'web' ? 'web' : 'android';

const todayStr = () => dateToStr(new Date());

const REPORT_FIELDS: [string, string][] = [['summary', 'Résumé'], ['needs', 'Besoins'], ['objections', 'Objections'], ['competitors', 'Concurrents'], ['decisions', 'Décisions'], ['next_step', 'Prochaine étape']];
const pickFields = (r?: Row): Record<string, string> => Object.fromEntries(REPORT_FIELDS.map(([k]) => [k, (r?.[k] as string | null) ?? '']));
const aiErrorMessage = (e: unknown): string => {
  if (e instanceof NetworkError) return 'Hors-ligne : la synthèse par IA demande une connexion.';
  const code = e instanceof ApiError ? e.code : '';
  return ({ ai_unavailable: 'La synthèse par IA n\'est pas activée sur ce serveur.', quota_exceeded: 'Plafond mensuel d\'IA atteint.', rate_limited: 'Trop de demandes : réessayez dans une minute.',
    ai_failed: 'Le service d\'IA n\'a pas pu répondre. Réessayez.', forbidden: 'Seul l\'auteur de la visite peut lancer la synthèse.' } as Record<string, string>)[code] ?? 'La synthèse a échoué. Réessayez.';
};

const MAX_DICTATION_S = 300;   // arrêt automatique d'une dictée
const voiceErrorMessage = (e: unknown): string => {
  if (e instanceof RecorderError) return e.kind === 'permission' ? 'Accès au micro refusé : autorisez-le dans les réglages du téléphone ou du navigateur.' : e.kind === 'unavailable' ? 'Le micro n\'est pas disponible.' : 'L\'enregistrement a échoué.';
  if (e instanceof NetworkError) return 'Hors-ligne : la transcription demande une connexion.';
  const code = e instanceof ApiError ? e.code : '';
  return ({ ai_unavailable: 'La transcription vocale n\'est pas activée sur ce serveur.', quota_exceeded: 'Plafond mensuel d\'IA atteint.', rate_limited: 'Trop de demandes : réessayez dans une minute.',
    ai_failed: 'Le service de transcription n\'a pas pu répondre. Réessayez.', payload_too_large: 'Enregistrement trop long.', forbidden: 'Seul l\'auteur de la visite peut dicter.' } as Record<string, string>)[code] ?? 'La transcription a échoué. Réessayez.';
};

type Screen = { name: 'today' } | { name: 'visit'; id: string } | { name: 'clients' } | { name: 'actions' } | { name: 'action'; id?: string } | { name: 'settings' };
interface Data { visits: Row[]; companies: Row[]; actions: Row[]; reports: Row[]; notes: Row[]; history: Row[]; pending: number }
interface Ctx { store: SqliteStore; engine: SyncEngine; client: ApiClient; userId: string; role: UserRole; lang: string }
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
    let role: UserRole = sess.role ?? 'commercial';
    let lang = sess.lang ?? 'fr';          // langue de dictée du profil : transcription et langue des comptes rendus
    try {   // profil à jour quand le réseau est disponible ; sinon valeurs conservées (hors-ligne : commercial et français par défaut)
      const me = await client.me();
      if (me.role !== role || me.dictation_language !== lang) { role = me.role; lang = me.dictation_language; await saveSession({ ...sess, role, lang }); }
    } catch { /* hors-ligne */ }
    setCtx({ store, engine, client, userId: sess.userId, role, lang });
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
      await onDone({ server, userId: me.id, role: me.role, lang: me.dictation_language, tokens });
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
  const { s, c, dark, pref, setPref } = useTheme();
  // Navigation : pile d'écrans. Le bouton retour du téléphone (Android) et celui du navigateur (version web) remontent
  // cette pile comme le bouton « Retour » de l'application ; à la racine seulement, ils quittent l'application.
  const [stack, setStack] = useState<Screen[]>([{ name: 'today' }]);
  const stackRef = useRef<Screen[]>(stack);
  const screen = stack[stack.length - 1]!;
  const TAB_SCREENS = ['today', 'clients', 'actions', 'settings'];
  const navigate = useCallback((next: Screen) => {
    const cur = stackRef.current;
    const isTab = TAB_SCREENS.includes(next.name);
    if (isTab && cur[cur.length - 1]!.name === next.name) return;
    const ns: Screen[] = isTab ? (next.name === 'today' ? [next] : [{ name: 'today' }, next]) : [...cur, next];
    stackRef.current = ns; setStack(ns);
    if (Platform.OS === 'web') history.pushState({ stack: ns }, '');
  }, []);
  const goBack = useCallback((): boolean => {
    if (stackRef.current.length < 2) return false;                   // racine : le système quitte l'application
    if (Platform.OS === 'web') history.back();                       // popstate remonte la pile
    else { const ns = stackRef.current.slice(0, -1); stackRef.current = ns; setStack(ns); }
    return true;
  }, []);
  useEffect(() => {
    if (Platform.OS === 'web') {
      history.replaceState({ stack: stackRef.current }, '');
      const onPop = (e: PopStateEvent) => { const ns: Screen[] = (e.state?.stack as Screen[] | undefined) ?? [{ name: 'today' }]; stackRef.current = ns; setStack(ns); };
      window.addEventListener('popstate', onPop);
      return () => window.removeEventListener('popstate', onPop);
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', goBack);
    return () => sub.remove();
  }, [goBack]);
  const [group, setGroup] = useState<'client' | 'date'>('client');
  const [showValidated, setShowValidated] = useState(false);       // visites validées : masquées par défaut
  const [showFinished, setShowFinished] = useState(false);         // actions terminées ou annulées : masquées par défaut
  const [data, setData] = useState<Data>({ visits: [], companies: [], actions: [], reports: [], notes: [], history: [], pending: 0 });
  const [status, setStatus] = useState<{ offline: boolean; msg?: string }>({ offline: false });
  const syncing = useRef(false);

  const load = useCallback(async () => {
    const { store } = ctx;
    setData({
      visits: await store.list('visits'), companies: await store.list('companies'), actions: await store.list('actions'),
      reports: await store.list('reports'), notes: await store.list('notes'), history: await store.list('visit_history'), pending: await store.pendingCount(),
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

  const shownVisits = data.visits.filter(v => showValidated || v.status !== 'validated');
  const hiddenValidated = data.visits.length - shownVisits.length;
  const groups = (() => {
    const m = new Map<string, Row[]>();
    for (const v of shownVisits) m.set(v.company_id, [...(m.get(v.company_id) ?? []), v]);
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
          <View style={s.rowBetween}>
            <Text style={[s.t, { flex: 1 }]}>Afficher les visites validées</Text>
            <Switch value={showValidated} onValueChange={setShowValidated} accessibilityLabel="Afficher les visites validées" trackColor={{ true: c.accent, false: c.line }} />
          </View>
          {hiddenValidated > 0 && <Text style={s.muted}>{hiddenValidated} visite{hiddenValidated > 1 ? 's' : ''} validée{hiddenValidated > 1 ? 's' : ''} masquée{hiddenValidated > 1 ? 's' : ''}.</Text>}
          {shownVisits.length === 0 && <Text style={s.muted}>{data.visits.length === 0 ? 'Aucune visite. Créez-en une depuis l\'onglet Clients.' : 'Aucune visite à afficher.'}</Text>}
          {group === 'client'
            ? groups.map(g => (
              <View key={g.id} style={{ gap: 8 }}>
                <View style={s.group}><Text accessibilityRole="header" style={s.h2}>{g.name}</Text><Text style={s.muted}>{g.visits.length} visite{g.visits.length > 1 ? 's' : ''}{g.visits.some(v => isVisitLate(v)) ? <Text style={{ color: c.late, fontWeight: '700' }}> · {g.visits.filter(v => isVisitLate(v)).length} en retard</Text> : null}</Text></View>
                {g.visits.map(v => <VisitRow key={v.id} v={v} onPress={() => navigate({ name: 'visit', id: v.id })} />)}
              </View>))
            : [...shownVisits].sort(byDateDesc).map(v => <VisitRow key={v.id} v={v} client={companyName(v.company_id)} onPress={() => navigate({ name: 'visit', id: v.id })} />)}
        </>}
        {screen.name === 'clients' && <>
          <Text style={s.h1}>Clients</Text>
          <Text style={s.muted}>Source : CRM, lecture seule. Toucher un client crée une visite.</Text>
          {data.companies.filter(c => c.status === 'active').map(c => (
            <Row key={c.id} title={c.name} sub={[c.city, c.sector].filter(Boolean).join(' · ')}
              onPress={() => act(async () => { const addr = companyAddress(c);
                const id = await ctx.engine.create('visit', { company_id: c.id, status: 'planned', planned_start: ceilTo15(new Date()).toISOString(), ...(addr ? { location_text: addr } : {}) }); navigate({ name: 'visit', id }); })} />
          ))}
        </>}
        {screen.name === 'visit' && <VisitScreen key={screen.id} visitId={screen.id} data={data} ctx={ctx} act={act} back={goBack} companyName={companyName} offline={status.offline} />}
        {screen.name === 'actions' && <>
          <View style={s.rowBetween}><Text style={s.h1}>Actions</Text><Btn small title="+ Nouvelle" onPress={() => navigate({ name: 'action' })} /></View>
          <View style={s.rowBetween}>
            <Text style={[s.t, { flex: 1 }]}>Afficher les actions terminées ou annulées</Text>
            <Switch value={showFinished} onValueChange={setShowFinished} accessibilityLabel="Afficher les actions terminées ou annulées" trackColor={{ true: c.accent, false: c.line }} />
          </View>
          {!showFinished && data.actions.some(a => a.status !== 'todo') && <Text style={s.muted}>{data.actions.filter(a => a.status !== 'todo').length} action(s) terminée(s) ou annulée(s) masquée(s).</Text>}
          {data.actions.filter(a => showFinished || a.status === 'todo').length === 0 && <Text style={s.muted}>Aucune action à afficher.</Text>}
          {[...data.actions].filter(a => showFinished || a.status === 'todo').sort((a, b) => String(a.due_date ?? '9').localeCompare(String(b.due_date ?? '9'))).map(a => {
            const late = isActionLate(a, todayStr());
            return (
            <View key={a.id} style={[s.rowCard, late && { borderLeftWidth: 6, borderLeftColor: c.late }]}>
              <Pressable onPress={() => act(() => ctx.engine.update('action', a.id, { status: a.status === 'done' ? 'todo' : 'done' }))} accessibilityRole="checkbox" accessibilityState={{ checked: a.status === 'done' }} style={[s.box, a.status === 'done' && s.boxOn, late && a.status === 'todo' && { borderColor: c.late }]} />
              <Pressable style={{ flex: 1, gap: 2 }} onPress={() => navigate({ name: 'action', id: a.id })}>
                <Text style={[s.t, a.status !== 'todo' && s.done]}>{a.title}</Text>
                <Text style={[s.muted, late && { color: c.late, fontWeight: '600' }]}>{companyName(a.company_id)} · {a.due_date ? fmtDate(a.due_date) : 'sans échéance'}{a.status === 'cancelled' ? ' · annulée' : ''}</Text>
                {late && <Pill text="En retard" color={c.late} />}
              </Pressable>
            </View>);
          })}
        </>}
        {screen.name === 'action' && <ActionForm key={screen.id ?? 'new'} id={screen.id} data={data} ctx={ctx} act={act} back={goBack} />}
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
          <Pressable key={k} style={s.tab} onPress={() => navigate({ name: k } as Screen)} accessibilityRole="button"><Text style={[s.tabText, screen.name === k && s.tabOn]}>{l}</Text></Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

function VisitRow({ v, client, onPress }: { v: Row; client?: string; onPress: () => void }) {
  const { c } = useTheme();
  const w = visitWhen(v);
  const late = isVisitLate(v);
  const col = visitStatusColor(c, v.status);
  const pills = [{ text: VISIT_STATUS[v.status] ?? v.status, color: col }, ...(late ? [{ text: 'En retard', color: c.late }] : [])];
  // Par client : la date est le titre. Par date : le client est le titre, la date en dessous.
  return <Row onPress={onPress} stripe={late ? c.late : col} pills={pills} tone={late ? 'late' : undefined}
    title={client ?? w.main} sub={client ? w.main : (w.sub ? `${w.sub}${v.objective ? ' · ' + v.objective : ''}` : v.objective ?? undefined)} />;
}

function VisitScreen({ visitId, data, ctx, act, back, companyName, offline }: { visitId: string; data: Data; ctx: Ctx; act: Act; back: () => void; companyName: (id: string) => string; offline: boolean }) {
  const { s, c } = useTheme();
  const v: Row | undefined = data.visits.find(x => x.id === visitId);
  const report: Row | undefined = data.reports.find(r => r.visit_id === visitId);
  const [f, setF] = useState<Record<string, string>>(() => pickFields(report));
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string>();
  const [ai, setAi] = useState<AiProposalResponse>();
  const [dictating, setDictating] = useState<string | null>(null);          // dictée en cours : une seule à la fois
  const [dictErr, setDictErr] = useState<{ id: string; msg: string }>();
  const [noteOpen, setNoteOpen] = useState(false);
  const setDictError = (id: string, msg?: string) => setDictErr(msg ? { id, msg } : undefined);
  const appendTo = (k: string, text: string) => setF(cur => ({ ...cur, [k]: cur[k] && cur[k]!.trim() ? `${cur[k]!.trimEnd()} ${text}` : text }));
  const [note, setNote] = useState('');
  const [sheet, setSheet] = useState<'none' | 'date' | 'address' | 'history' | 'nav'>('none');
  const company: Row | undefined = data.companies.find(co => co.id === v?.company_id);
  // L'adresse appartient à la visite : copiée du client à la création, elle ne suit pas ensuite les changements du client.
  // (Visites créées avant cette règle, sans adresse : on affiche celle du client en repli.)
  const address: string = (v?.location_text ?? '') || companyAddress(company);
  const entries = data.history.filter(h => h.visit_id === visitId).sort((a, b) => String(b.changed_at).localeCompare(String(a.changed_at)));
  if (!v) return <><Btn small title="‹ Retour" onPress={back} /><Text style={s.muted}>Visite introuvable (supprimée ou plus accessible).</Text></>;
  const mine = v.author_id === ctx.userId;
  const canDate = canEditVisitDate(v.status, mine);
  const canAddress = canEditVisitAddress(v.status, ctx.role);
  const setStatus = (status: string, extra: Row = {}) => act(() => ctx.engine.update('visit', v.id, { status, ...extra }));
  const saveReport = (validate: boolean, values: Record<string, string> = f) => act(async () => {
    const st = validate ? 'validated' : 'draft';
    if (!report) await ctx.engine.create('report', { visit_id: visitId, language: ctx.lang, ...values, status: st });
    else await ctx.engine.update('report', report.id, { ...values, ...(validate ? { status: st } : {}) });
  });
  const notesText = data.notes.filter(n => n.visit_id === visitId && n.body).map(n => n.body).join('\n');
  // Synthèse par IA : le compte rendu doit exister sur le serveur ; on le crée en brouillon et on synchronise d'abord.
  const synthesize = async () => {
    setAiBusy(true); setAiErr(undefined);
    try {
      let rid = report?.id as string | undefined;
      if (!rid) rid = await ctx.engine.create('report', { visit_id: visitId, language: ctx.lang, status: 'draft' });
      const rep = await ctx.engine.sync();
      if (rep.offline) throw new NetworkError();
      setAi(await ctx.client.aiPropose(rid, notesText, dateToStr(new Date())));
    } catch (e) { setAiErr(aiErrorMessage(e)); }
    finally { setAiBusy(false); }
  };
  const applyAi = (fields: Record<string, string>, actions: { title: string; due_date: string | null }[]) => {
    const merged = { ...f, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim())) };   // un champ vide proposé n'efface rien
    setF(merged); setAi(undefined);
    void act(async () => {
      if (report) await ctx.engine.update('report', report.id, merged);
      else await ctx.engine.create('report', { visit_id: visitId, language: ctx.lang, ...merged, status: 'draft' });
      for (const a of actions) await ctx.engine.create('action', { company_id: v!.company_id, visit_id: visitId, title: a.title, origin: 'ai', ...(a.due_date ? { due_date: a.due_date } : {}) });
    });
  };
  const Icon = ({ label, onPress }: { label: string; onPress: () => void }) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={s.iconBtn}><Text style={s.iconText}>✎</Text></Pressable>);
  return <>
    <View style={s.headerRow}>
      <Pressable onPress={back} accessibilityRole="button" style={s.backBtn}><Text style={s.link}>‹ Retour</Text></Pressable>
      <Text style={s.titleCenter} numberOfLines={1} accessibilityRole="header">{companyName(v.company_id)}</Text>
      <View style={s.backBtn} />
    </View>
    <View style={[s.rowCard, { flexDirection: 'column', alignItems: 'stretch', gap: 4 }]}>
      <View style={s.fact}><Text style={s.muted}>Statut</Text><View style={{ flexDirection: 'row', gap: 6 }}><Pill text={VISIT_STATUS[v.status] ?? v.status} color={visitStatusColor(c, v.status)} />{isVisitLate(v) && <Pill text="En retard" color={c.late} />}</View></View>
      <View style={s.fact}><Text style={s.muted}>Prévue</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
          <Text style={[s.t, { flexShrink: 1, textAlign: 'right' }, isVisitLate(v) && { color: c.late }]}>{v.planned_start ? fmtDateTime(v.planned_start) : 'non planifiée'}</Text>
          {canDate && <Icon label="Modifier la date prévue" onPress={() => setSheet('date')} />}
        </View></View>
      <View style={s.fact}><Text style={s.muted}>Commencée</Text><Text style={s.t}>{v.started_at ? fmtDateTime(v.started_at) : '—'}</Text></View>
      <View style={s.fact}><Text style={s.muted}>Terminée</Text><Text style={s.t}>{v.ended_at ? fmtDateTime(v.ended_at) : '—'}</Text></View>
      <View style={s.fact}><Text style={s.muted}>Adresse de la visite</Text>{canAddress && <Icon label="Modifier l'adresse de la visite" onPress={() => setSheet('address')} />}</View>
      {address
        ? <Pressable onPress={() => setSheet('nav')} accessibilityRole="link" accessibilityLabel="Ouvrir l'itinéraire"><Text style={[s.t, { color: c.accent, textDecorationLine: 'underline' }]}>{address}  ›</Text></Pressable>
        : <Text style={s.muted}>Aucune adresse{canAddress ? ' : touchez le crayon pour en saisir une.' : '.'}</Text>}
      <Pressable onPress={() => setSheet('history')} accessibilityRole="button" style={{ minHeight: 36, justifyContent: 'center' }}>
        <Text style={s.link}>Historique des modifications ({entries.length})</Text></Pressable>
    </View>
    {mine && v.status === 'planned' && <Btn title="Visite organisée avec le client" onPress={() => setStatus('organized')} />}
    {mine && (v.status === 'planned' || v.status === 'organized') && <Btn title="Démarrer la visite" onPress={() => setStatus('in_progress', { started_at: new Date().toISOString() })} />}
    {mine && v.status === 'in_progress' && <Btn title="Terminer la visite" onPress={() => setStatus('done', { ended_at: new Date().toISOString() })} />}
    <Label>Notes durant visite</Label>
    {data.notes.filter(n => n.visit_id === visitId).map(n => <Text key={n.id} style={s.note}>{n.body}</Text>)}
    {mine && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <DictationControl id="notes" label="Notes durant visite" review active={dictating} setActive={setDictating} ctx={ctx} visitId={visitId} offline={offline}
        onText={text => act(() => ctx.engine.create('note', { visit_id: visitId, kind: 'voice', body: text }))} onError={setDictError} />
      {dictating !== 'notes' && <Btn small title="+ Ajouter une note" onPress={() => setNoteOpen(true)} />}
    </View>}
    {dictErr?.id === 'notes' && <Text style={s.err}>{dictErr.msg}</Text>}
    {mine && <>
      <Btn small title={aiBusy ? 'Synthèse en cours…' : 'Synthétiser avec l\'IA'} disabled={aiBusy || !notesText.trim() || offline} onPress={synthesize} />
      <Text style={s.muted}>À partir des notes durant visite.</Text>
      {offline && <Text style={s.muted}>Hors-ligne : la synthèse par IA demande une connexion.</Text>}
      {!notesText.trim() && <Text style={s.muted}>Ajoutez des notes durant visite pour pouvoir les synthétiser.</Text>}
      {aiErr && <Text style={s.err}>{aiErr}</Text>}
    </>}
    <Label>Compte rendu {report?.status === 'validated' ? '(validé)' : ''}</Label>
    {REPORT_FIELDS.map(([k, label]) => (
      <View key={k} style={{ gap: 4 }}>
        <View style={s.rowBetween}>
          <Text style={s.muted}>{label}</Text>
          {mine && <DictationControl compact id={`field:${k}`} label={label} active={dictating} setActive={setDictating} ctx={ctx} visitId={visitId} offline={offline}
            onText={text => appendTo(k, text)} onError={setDictError} />}
        </View>
        {dictErr?.id === `field:${k}` && <Text style={s.err}>{dictErr.msg}</Text>}
        <TextInput accessibilityLabel={k === 'summary' ? 'Résumé du compte rendu' : label} placeholderTextColor={c.muted} style={[s.input, { minHeight: k === 'summary' ? 90 : 60 }]}
          value={f[k] ?? ''} onChangeText={t => setF(cur => ({ ...cur, [k]: t }))} multiline editable={mine} />
      </View>))}
    {mine && <View style={s.rowBetween}>
      <Btn small title="Enregistrer" onPress={() => saveReport(false)} />
      <Btn small title="Valider" disabled={!(f.summary ?? '').trim() || report?.status === 'validated'} onPress={() => saveReport(true)} />
    </View>}
    <AddNoteSheet visible={noteOpen} onClose={() => setNoteOpen(false)} onAdd={text => { setNoteOpen(false); void act(() => ctx.engine.create('note', { visit_id: visitId, kind: 'text', body: text })); }} />
    <AiSheet result={ai} onClose={() => setAi(undefined)} onApply={applyAi} />

    <EditDateSheet visible={sheet === 'date'} initial={v.planned_start} onClose={() => setSheet('none')}
      onSave={d => { setSheet('none'); void act(() => ctx.engine.update('visit', v.id, { planned_start: d ? d.toISOString() : null })); }} />
    <EditAddressSheet visible={sheet === 'address'} initial={address} onClose={() => setSheet('none')}
      onSave={t => { setSheet('none'); void act(() => ctx.engine.update('visit', v.id, { location_text: t.trim() || null })); }} />
    <HistorySheet visible={sheet === 'history'} entries={entries} onClose={() => setSheet('none')} />
    <NavChooser address={address} visible={sheet === 'nav'} onClose={() => setSheet('none')} />
  </>;
}

function AddNoteSheet({ visible, onClose, onAdd }: { visible: boolean; onClose: () => void; onAdd: (text: string) => void }) {
  const { s, c } = useTheme();
  const [text, setText] = useState('');
  useEffect(() => { if (visible) setText(''); }, [visible]);
  return (
    <Sheet title="Note durant la visite" visible={visible} onClose={onClose}>
      <TextInput accessibilityLabel="Nouvelle note" placeholderTextColor={c.muted} style={[s.input, { minHeight: 110 }]} value={text} onChangeText={setText} placeholder="Ce qui se dit pendant la visite" multiline />
      <Text style={s.muted}>Ces notes servent à rédiger le compte rendu (synthèse par IA comprise).</Text>
      <Btn title="Ajouter" disabled={!text.trim()} onPress={() => onAdd(text.trim())} />
      <Btn small title="Annuler" onPress={onClose} />
    </Sheet>
  );
}

function EditDateSheet({ visible, initial, onClose, onSave }: { visible: boolean; initial?: string | null; onClose: () => void; onSave: (d?: Date) => void }) {
  const [value, setValue] = useState<Date | undefined>();
  useEffect(() => { if (visible) setValue(initial ? new Date(initial) : undefined); }, [visible, initial]);
  const changed = (value?.toISOString() ?? null) !== (initial ?? null);
  return (
    <Sheet title="Modifier la date prévue" visible={visible} onClose={onClose}>
      <DateField label="Date et heure prévues" mode="datetime" value={value} onChange={setValue} clearable />
      <Text style={useTheme().s.muted}>L'ancienne date reste consultable dans l'historique.</Text>
      <Btn title="Enregistrer" disabled={!changed} onPress={() => onSave(value)} />
      <Btn small title="Annuler" onPress={onClose} />
    </Sheet>
  );
}

function EditAddressSheet({ visible, initial, onClose, onSave }: { visible: boolean; initial: string; onClose: () => void; onSave: (t: string) => void }) {
  const { s, c } = useTheme();
  const [text, setText] = useState(initial);
  useEffect(() => { if (visible) setText(initial); }, [visible, initial]);
  return (
    <Sheet title="Adresse de la visite" visible={visible} onClose={onClose}>
      <TextInput accessibilityLabel="Adresse de la visite" placeholderTextColor={c.muted} style={[s.input, { minHeight: 90 }]} value={text} onChangeText={setText} placeholder="Numéro, rue, code postal, ville" multiline />
      <Text style={s.muted}>L'adresse du client n'est pas modifiée : elle ne concerne que cette visite.</Text>
      <Btn title="Enregistrer" disabled={text.trim() === initial.trim()} onPress={() => onSave(text)} />
      <Btn small title="Annuler" onPress={onClose} />
    </Sheet>
  );
}

function HistorySheet({ visible, entries, onClose }: { visible: boolean; entries: Row[]; onClose: () => void }) {
  const { s } = useTheme();
  const val = (e: Row, v?: string | null) => !v ? '—' : e.field === 'planned_start' ? fmtDateTime(v) : v;
  return (
    <Sheet title="Historique des modifications" visible={visible} onClose={onClose}>
      {entries.length === 0 && <Text style={s.muted}>Aucune modification depuis la création de la visite.</Text>}
      {entries.map(e => (
        <View key={e.id} style={s.hist}>
          <Text style={s.t}>{e.field === 'planned_start' ? 'Date prévue' : 'Adresse de la visite'}</Text>
          <Text style={s.muted}>{fmtDateTime(e.changed_at)} · {e.changed_by_name}</Text>
          <Text style={{ color: s.t.color }}>{val(e, e.old_value)}  →  {val(e, e.new_value)}</Text>
        </View>))}
      <Btn small title="Fermer" onPress={onClose} />
    </Sheet>
  );
}

/**
 * Dictée : enregistre, envoie l'audio au back pour transcription (Voxtral). Deux usages :
 *  - `review` (notes durant visite) : le texte est affiché à relire, la note n'est créée qu'ensuite ;
 *  - direct (champs du compte rendu) : le texte est ajouté à la fin du champ, que l'utilisateur corrige sur place.
 * Un seul enregistrement à la fois (`active`). En ligne seulement : l'audio n'est pas conservé en attendant le réseau.
 */
function DictationControl({ id, label, active, setActive, ctx, visitId, offline, review, compact, onText, onError }: {
  id: string; label: string; active: string | null; setActive: (id: string | null) => void; ctx: Ctx; visitId: string; offline: boolean;
  review?: boolean; compact?: boolean; onText: (text: string) => void; onError: (id: string, msg?: string) => void;
}) {
  const { s, c } = useTheme();
  const rec = useRef<Recorder>();
  rec.current ??= createRecorder();
  const [state, setState] = useState<'idle' | 'recording' | 'sending' | 'review'>('idle');
  const [secs, setSecs] = useState(0);
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => () => { clearInterval(timer.current); void rec.current?.cancel(); }, []);
  const busyElsewhere = active !== null && active !== id;

  const done = () => { setState('idle'); setActive(null); };
  const send = async (audio: RecordedAudio) => {
    setActive(id); setState('sending'); onError(id, undefined);
    try {
      const r = await ctx.client.transcribe(visitId, audio.body, audio.mime, ctx.lang, audio.durationS);
      if (review) { setText(r.text); setState('review'); } else { onText(r.text.trim()); done(); }
    } catch (e) { onError(id, voiceErrorMessage(e)); done(); }
  };
  const start = async () => {
    onError(id, undefined);
    try { await rec.current!.start(); setActive(id); setSecs(0); setState('recording'); timer.current = setInterval(() => setSecs(x => x + 1), 1000); }
    catch (e) { onError(id, voiceErrorMessage(e)); }
  };
  const stop = async () => {
    clearInterval(timer.current);
    try { await send(await rec.current!.stop()); } catch (e) { onError(id, voiceErrorMessage(e)); done(); }
  };
  useEffect(() => { if (state === 'recording' && secs >= MAX_DICTATION_S) void stop(); }, [secs, state]);

  if (state === 'review') return (
    <View style={{ gap: 8, flexBasis: '100%' }}>
      <Label>Note dictée : relisez et corrigez</Label>
      <TextInput accessibilityLabel="Texte dicté" placeholderTextColor={c.muted} style={[s.input, { minHeight: 90 }]} value={text} onChangeText={setText} multiline />
      <Text style={s.muted}>Texte transcrit automatiquement : des erreurs sont possibles (noms, nombres).</Text>
      <View style={s.rowBetween}>
        <Btn small title="Ajouter la note" disabled={!text.trim()} onPress={() => { onText(text.trim()); setText(''); done(); }} />
        <Btn small title="Annuler" onPress={() => { setText(''); done(); }} />
      </View>
    </View>);

  const mm = String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
  if (state === 'recording') return compact
    ? <Pressable onPress={stop} accessibilityRole="button" accessibilityLabel="Arrêter la dictée" style={[s.btn, s.btnSmall, { minHeight: 36, paddingVertical: 4, backgroundColor: c.late }]}><Text style={s.btnText}>■ {mm}</Text></Pressable>
    : <Btn small title={`■ Arrêter la dictée · ${mm}`} onPress={stop} />;
  const disabled = state === 'sending' || offline || busyElsewhere;
  if (!rec.current.available) return compact
    ? <AudioFilePicker compact label={label} disabled={disabled} onFile={send} />
    : (
      <View style={{ gap: 4, flexBasis: '100%' }}>
        <AudioFilePicker disabled={disabled} onFile={send} />
        <Text style={s.muted}>Le micro du navigateur demande une connexion sécurisée (HTTPS). En attendant, enregistrez avec le téléphone puis choisissez le fichier.</Text>
      </View>);
  if (compact) return (
    <Pressable onPress={start} disabled={disabled} accessibilityRole="button" accessibilityLabel={`Dicter : ${label}`} style={[s.iconBtn, disabled && s.btnOff]}>
      <Text style={s.iconText}>{state === 'sending' ? '…' : '🎤'}</Text></Pressable>);
  return <Btn small title={state === 'sending' ? 'Transcription en cours…' : '🎤 Dicter une note'} disabled={disabled} onPress={start} />;
}

/** Proposition de l'IA : à relire et corriger avant de l'appliquer. Rien n'est enregistré tant que l'utilisateur n'applique pas. */
function AiSheet({ result, onClose, onApply }: { result?: AiProposalResponse; onClose: () => void; onApply: (fields: Record<string, string>, actions: { title: string; due_date: string | null }[]) => void }) {
  const { s, c } = useTheme();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [acts, setActs] = useState<{ title: string; due_date: string | null; due_date_certain: boolean; on: boolean }[]>([]);
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    if (!result) return;
    setFields({ ...result.proposal.fields }); setActs(result.proposal.actions.map(a => ({ ...a, on: true }))); setShowSource(false);
  }, [result]);
  return (
    <Sheet title="Proposition de l'IA" visible={!!result} onClose={onClose}>
      <Text style={s.muted}>Proposé par l'IA : relisez et corrigez avant d'appliquer. Rien n'est enregistré tant que vous n'appliquez pas.</Text>
      {result && result.warnings.length > 0 && (
        <View style={[s.rowCard, { flexDirection: 'column', alignItems: 'stretch', gap: 4, borderLeftWidth: 6, borderLeftColor: c.stPlanned }]}>
          <Text style={s.t}>À vérifier</Text>
          {result.warnings.map((w, i) => <Text key={i} style={s.muted}>• {w}</Text>)}
        </View>)}
      {REPORT_FIELDS.map(([k, label]) => (
        <View key={k} style={{ gap: 4 }}>
          <Text style={s.muted}>{label}</Text>
          <TextInput accessibilityLabel={`Proposition : ${label}`} placeholderTextColor={c.muted} style={[s.input, { minHeight: 48 }]} value={fields[k] ?? ''} onChangeText={t => setFields(cur => ({ ...cur, [k]: t }))} multiline />
        </View>))}
      {acts.length > 0 && <Label>Actions proposées</Label>}
      {acts.map((a, i) => (
        <View key={i} style={s.rowBetween}>
          <Switch value={a.on} onValueChange={on => setActs(cur => cur.map((x, j) => j === i ? { ...x, on } : x))} accessibilityLabel={`Créer l'action : ${a.title}`} trackColor={{ true: c.accent, false: c.line }} />
          <View style={{ flex: 1 }}>
            <TextInput accessibilityLabel={`Action proposée ${i + 1}`} placeholderTextColor={c.muted} style={s.input} value={a.title} onChangeText={t => setActs(cur => cur.map((x, j) => j === i ? { ...x, title: t } : x))} />
            <Text style={s.muted}>{a.due_date ? `${fmtDate(a.due_date)}${a.due_date_certain ? '' : ' (calculée : à vérifier)'}` : 'sans échéance'}</Text>
          </View>
        </View>))}
      <Pressable onPress={() => setShowSource(x => !x)} accessibilityRole="button"><Text style={s.link}>{showSource ? 'Masquer' : 'Voir'} le texte source</Text></Pressable>
      {showSource && <Text style={s.note}>{result?.source_text}</Text>}
      <Btn title="Appliquer au compte rendu" onPress={() => onApply(fields, acts.filter(a => a.on && a.title.trim()).map(a => ({ title: a.title.trim(), due_date: a.due_date })))} />
      <Btn small title="Ignorer" onPress={onClose} />
    </Sheet>
  );
}

function ActionForm({ id, data, ctx, act, back }: { id?: string; data: Data; ctx: Ctx; act: Act; back: () => void }) {
  const { s, c } = useTheme();
  const existing: Row | undefined = id ? data.actions.find(a => a.id === id) : undefined;
  const [title, setTitle] = useState(existing?.title ?? ''); const [due, setDue] = useState<Date | undefined>(strToDate(existing?.due_date));
  const [company, setCompany] = useState<string>(existing?.company_id ?? data.companies[0]?.id ?? '');
  const valid = title.trim().length > 0 && !!company;
  return <>
    <Btn small title="‹ Retour" onPress={back} />
    <Text style={s.h1}>{existing ? 'Modifier l\'action' : 'Nouvelle action'}</Text>
    <Label>Intitulé</Label><TextInput accessibilityLabel="Intitulé de l'action" placeholderTextColor={c.muted} style={s.input} value={title} onChangeText={setTitle} />
    <Label>Client</Label>
    {data.companies.map(co => <Pressable key={co.id} onPress={() => !existing && setCompany(co.id)} style={[s.choice, company === co.id && s.choiceOn]}><Text style={{ color: c.text }}>{co.name}</Text></Pressable>)}
    <Label>Échéance</Label><DateField label="Échéance" mode="date" value={due} onChange={setDue} clearable />
    <Text style={s.muted}>Responsable : vous.</Text>
    <Btn title="Enregistrer" disabled={!valid} onPress={() => act(async () => {
      if (existing) await ctx.engine.update('action', existing.id, { title: title.trim(), due_date: due ? dateToStr(due) : null });
      else await ctx.engine.create('action', { company_id: company, title: title.trim(), ...(due ? { due_date: dateToStr(due) } : {}), origin: 'manual' });
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
const Pill = ({ text, color }: { text: string; color: string }) => {
  const { s } = useTheme();
  return <View style={[s.pill, { backgroundColor: color + '26', borderWidth: 1, borderColor: color }]}><Text style={[s.pillText, { color }]}>{text}</Text></View>;
};
const Row = ({ title, sub, pills, stripe, onPress, tone }: { title: string; sub?: string; pills?: { text: string; color: string }[]; stripe?: string; onPress: () => void; tone?: 'late' }) => {
  const { s, c } = useTheme();
  return (
    <Pressable onPress={onPress} style={[s.rowCard, stripe ? { borderLeftWidth: 6, borderLeftColor: stripe } : null]} accessibilityRole="button">
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.t}>{title}</Text>
        {sub ? <Text style={[s.muted, tone === 'late' && { color: c.late, fontWeight: '600' }]}>{sub}</Text> : null}
        {pills?.length ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>{pills.map(p => <Pill key={p.text} text={p.text} color={p.color} />)}</View> : null}
      </View>
      <Text style={s.muted}>›</Text>
    </Pressable>
  );
};
