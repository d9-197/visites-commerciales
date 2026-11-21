import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Platform, Pressable, SafeAreaView, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ApiClient, ApiError, NetworkError, SyncEngine, uuidv4, type AiProposalResponse, type Row, type SyncReport } from '@visites/sync-core';
import type { SqliteStore } from '@visites/sync-core';
import { openStore } from './src/expoDb';
import { clearSession, loadSession, saveSession, saveTokens, type Session, type ThemePref } from './src/session';
import { ThemeProvider, useTheme, visitStatusColor } from './src/theme';
import { REPORT_LATE_DAYS, canEditInternalNote, isDueBeforeVisit, isReportLate, visitStage, canDeleteVisit, canEditVisitAddress, canEditVisitDate, canEditVisitNotes, canValidateReport, isActionLate, isVisitLate, type UserRole } from '@visites/sync-core';
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

type Screen = { name: 'today' } | { name: 'visit'; id: string } | { name: 'report'; id: string } | { name: 'clients' } | { name: 'client'; id: string } | { name: 'actions'; visitId?: string } | { name: 'action'; id: string } | { name: 'settings' };
interface Data { visits: Row[]; companies: Row[]; actions: Row[]; reports: Row[]; notes: Row[]; internalNotes: Row[]; history: Row[]; colleagues: Row[]; pending: number }
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
    const top = cur[cur.length - 1]! as { name: string; visitId?: string };
    // Actions d'une visite : écran empilé (le retour ramène à la visite) ; sinon onglet.
    const isTab = TAB_SCREENS.includes(next.name) && !(next.name === 'actions' && (next as { visitId?: string }).visitId);
    if (isTab && top.name === next.name && !top.visitId) return;
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
  const [showDeleted, setShowDeleted] = useState(false);         // visites supprimées : masquées par défaut
  const [showFinished, setShowFinished] = useState(false);         // actions terminées ou annulées : masquées par défaut
  const [data, setData] = useState<Data>({ visits: [], companies: [], actions: [], reports: [], notes: [], internalNotes: [], history: [], colleagues: [], pending: 0 });
  const [status, setStatus] = useState<{ offline: boolean; msg?: string }>({ offline: false });
  const syncing = useRef(false);

  const load = useCallback(async () => {
    const { store } = ctx;
    setData({
      visits: await store.list('visits'), companies: await store.list('companies'), actions: await store.list('actions'),
      reports: await store.list('reports'), notes: await store.list('notes'), internalNotes: await store.list('internal_notes'), history: await store.list('visit_history'), colleagues: await store.list('colleagues'), pending: await store.pendingCount(),
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

  const openActionsOf = (visitId: string) => data.actions.filter(a => a.visit_id === visitId && a.status === 'todo').length;
  // Une visite n'est « terminée » (donc masquable) que lorsque son compte rendu est validé ET que toutes ses actions sont faites.
  const lateReports = data.visits.filter(v => isReportLate(v));
  const visibleVisits = data.visits.filter(v => showDeleted || v.status !== 'deleted');
  const shownVisits = visibleVisits.filter(v => showValidated || visitStage(v.status, openActionsOf(v.id)) !== 'closed');
  const hiddenValidated = visibleVisits.length - shownVisits.length;
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
          {lateReports.length > 0 && <View style={[s.rowCard, { borderLeftWidth: 6, borderLeftColor: c.late, flexDirection: 'column', alignItems: 'stretch', gap: 2 }]} accessibilityRole="alert">
            <Text style={[s.t, { color: c.late, fontWeight: '700' }]}>{lateReports.length} compte{lateReports.length > 1 ? 's' : ''} rendu{lateReports.length > 1 ? 's' : ''} à valider depuis plus de {REPORT_LATE_DAYS} jours</Text>
            <Text style={s.muted}>{lateReports.slice(0, 3).map(v => companyName(v.company_id)).join(', ')}{lateReports.length > 3 ? '…' : ''}{ctx.role !== 'commercial' ? ' · équipe incluse' : ''}. Sans validation, aucune action n'est créée.</Text>
          </View>}
          <View style={s.rowBetween}>
            <Text style={[s.t, { flex: 1 }]}>Afficher les visites terminées</Text>
            <Switch value={showValidated} onValueChange={setShowValidated} accessibilityLabel="Afficher les visites terminées" trackColor={{ true: c.accent, false: c.line }} />
          </View>
          <View style={s.rowBetween}>
            <Text style={[s.t, { flex: 1 }]}>Afficher les visites supprimées</Text>
            <Switch value={showDeleted} onValueChange={setShowDeleted} accessibilityLabel="Afficher les visites supprimées" trackColor={{ true: c.accent, false: c.line }} />
          </View>
          {hiddenValidated > 0 && <Text style={s.muted}>{hiddenValidated} visite{hiddenValidated > 1 ? 's' : ''} terminée{hiddenValidated > 1 ? 's' : ''} masquée{hiddenValidated > 1 ? 's' : ''}.</Text>}
          {shownVisits.length === 0 && <Text style={s.muted}>{data.visits.length === 0 ? 'Aucune visite. Ouvrez un client (onglet Clients) pour en planifier une.' : 'Aucune visite à afficher.'}</Text>}
          {group === 'client'
            ? groups.map(g => (
              <View key={g.id} style={{ gap: 8 }}>
                <View style={s.group}><Text accessibilityRole="header" style={s.h2}>{g.name}</Text><Text style={s.muted}>{g.visits.length} visite{g.visits.length > 1 ? 's' : ''}{g.visits.some(v => isVisitLate(v)) ? <Text style={{ color: c.late, fontWeight: '700' }}> · {g.visits.filter(v => isVisitLate(v)).length} en retard</Text> : null}</Text></View>
                {g.visits.map(v => <VisitRow key={v.id} v={v} onPress={() => navigate({ name: 'visit', id: v.id })} openActions={openActionsOf(v.id)} />)}
              </View>))
            : [...shownVisits].sort(byDateDesc).map(v => <VisitRow key={v.id} v={v} client={companyName(v.company_id)} onPress={() => navigate({ name: 'visit', id: v.id })} openActions={openActionsOf(v.id)} />)}
        </>}
        {screen.name === 'clients' && <>
          <Text style={s.h1}>Clients</Text>
          <Text style={s.muted}>Source : CRM, lecture seule. Touchez un client pour voir sa fiche, ses visites et ses actions.</Text>
          {data.companies.filter(c => c.status === 'active').map(c => (
            <Row key={c.id} title={c.name} sub={[c.city, c.sector].filter(Boolean).join(' · ')}
              onPress={() => navigate({ name: 'client', id: c.id })} />
          ))}
        </>}
        {screen.name === 'client' && <ClientScreen key={screen.id} companyId={screen.id} data={data} ctx={ctx} act={act} back={goBack} showDeleted={showDeleted} showFinished={showFinished}
          openVisit={id => navigate({ name: 'visit', id })} openAction={id => navigate({ name: 'action', id })}
          planVisit={async co => { const addr = companyAddress(co);
            const id = await ctx.engine.create('visit', { company_id: co.id, status: 'planned', planned_start: ceilTo15(new Date()).toISOString(), ...(addr ? { location_text: addr } : {}) }); await load(); void sync(); navigate({ name: 'visit', id }); }} />}
        {screen.name === 'visit' && <VisitScreen key={screen.id} visitId={screen.id} data={data} ctx={ctx} act={act} back={goBack} companyName={companyName} offline={status.offline} openReport={() => navigate({ name: 'report', id: screen.id })} openActions={() => navigate({ name: 'actions', visitId: screen.id })} />}
        {screen.name === 'report' && <ReportScreen key={screen.id} visitId={screen.id} data={data} ctx={ctx} act={act} back={goBack} companyName={companyName} offline={status.offline} openActions={() => navigate({ name: 'actions', visitId: screen.id })} />}
        {screen.name === 'actions' && (() => {
          const filterVisit = screen.visitId ? data.visits.find(x => x.id === screen.visitId) : undefined;
          const inScope = data.actions.filter(a => !screen.visitId || a.visit_id === screen.visitId);
          const shown = inScope.filter(a => showFinished || a.status === 'todo');
          return <>
            <Text style={s.h1}>Actions</Text>
            {screen.visitId && (
              <View style={[s.rowCard, { flexDirection: 'column', alignItems: 'stretch', gap: 6 }]}>
                <Text style={s.t}>Actions de la visite{filterVisit ? ` · ${companyName(filterVisit.company_id)}` : ''}</Text>
                {filterVisit && <Pressable onPress={() => navigate({ name: 'visit', id: filterVisit.id })} accessibilityRole="button" accessibilityLabel="Ouvrir la visite"><Text style={s.link}>Ouvrir la visite ›</Text></Pressable>}
                <Pressable onPress={() => navigate({ name: 'actions' })} accessibilityRole="button" accessibilityLabel="Toutes les actions"><Text style={s.link}>Toutes les actions</Text></Pressable>
              </View>)}
            {ctx.role !== 'commercial' && !screen.visitId && (() => {
              // Suivi d'équipe : actions à faire et en retard par responsable (hors les siennes).
              const today = todayStr();
              const by = new Map<string, { todo: number; late: number }>();
              for (const x of data.actions) {
                if (x.status !== 'todo' || x.owner_id === ctx.userId) continue;
                const e = by.get(x.owner_id) ?? { todo: 0, late: 0 };
                e.todo++; if (isActionLate(x, today)) e.late++;
                by.set(x.owner_id, e);
              }
              const rows = [...by.entries()].map(([id, e]) => ({ id, name: data.colleagues.find(u => u.id === id)?.display_name ?? 'Commercial', ...e })).sort((p, q) => q.late - p.late || p.name.localeCompare(q.name, 'fr'));
              if (rows.length === 0) return null;
              const totalLate = rows.reduce((n, r) => n + r.late, 0);
              return <View style={[s.rowCard, { flexDirection: 'column', alignItems: 'stretch', gap: 4 }]} accessibilityLabel="Actions de l'équipe">
                <Text style={s.t}>Équipe · {totalLate} action{totalLate > 1 ? 's' : ''} en retard</Text>
                {rows.map(r => <View key={r.id} style={s.fact}><Text style={s.muted}>{r.name}</Text><Text style={[s.t, r.late > 0 && { color: c.late, fontWeight: '700' }]}>{r.late} en retard · {r.todo} à faire</Text></View>)}
              </View>;
            })()}
            <View style={s.rowBetween}>
              <Text style={[s.t, { flex: 1 }]}>Afficher les actions terminées ou annulées</Text>
              <Switch value={showFinished} onValueChange={setShowFinished} accessibilityLabel="Afficher les actions terminées ou annulées" trackColor={{ true: c.accent, false: c.line }} />
            </View>
            {!showFinished && inScope.some(a => a.status !== 'todo') && <Text style={s.muted}>{inScope.filter(a => a.status !== 'todo').length} action(s) terminée(s) ou annulée(s) masquée(s).</Text>}
            {shown.length === 0 && <Text style={s.muted}>Aucune action à afficher. Les actions naissent d'une visite : à la validation du compte rendu, ou depuis la visite une fois le compte rendu validé.</Text>}
            {[...shown].sort((a, b) => String(a.due_date ?? '9').localeCompare(String(b.due_date ?? '9'))).map(a => {
              const late = isActionLate(a, todayStr());
              const visit = data.visits.find(x => x.id === a.visit_id);
              return (
              <View key={a.id} style={[s.rowCard, late && { borderLeftWidth: 6, borderLeftColor: c.late }]}>
                <Pressable onPress={() => act(() => ctx.engine.update('action', a.id, { status: a.status === 'done' ? 'todo' : 'done' }))} accessibilityRole="checkbox" accessibilityState={{ checked: a.status === 'done' }} style={[s.box, a.status === 'done' && s.boxOn, late && a.status === 'todo' && { borderColor: c.late }]} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Pressable onPress={() => navigate({ name: 'action', id: a.id })} accessibilityRole="button" accessibilityLabel={`Modifier l'action : ${a.title}`}>
                    <Text style={[s.t, a.status !== 'todo' && s.done]}>{a.title}</Text>
                    <Text style={[s.muted, late && { color: c.late, fontWeight: '600' }]}>{companyName(a.company_id)} · {a.due_date ? fmtDate(a.due_date) : 'sans échéance'}{a.status === 'cancelled' ? ' · annulée' : ''}</Text>
                  </Pressable>
                  {late && <Pill text="En retard" color={c.late} />}
                  {visit && <Pressable onPress={() => navigate({ name: 'visit', id: visit.id })} accessibilityRole="link" accessibilityLabel={`Voir la visite de l'action : ${a.title}`} style={{ minHeight: 32, justifyContent: 'center' }}>
                    <Text style={s.link}>Voir la visite{visit.planned_start ? ` du ${fmtDate(String(visit.planned_start).slice(0, 10))}` : ''} ›</Text></Pressable>}
                </View>
              </View>);
            })}
          </>;
        })()}
        {screen.name === 'action' && <ActionForm key={screen.id} id={screen.id} data={data} ctx={ctx} act={act} back={goBack} companyName={companyName} openVisit={id => navigate({ name: 'visit', id })} />}
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
          <Pressable key={k} style={s.tab} onPress={() => navigate({ name: k } as Screen)} accessibilityRole="button"><Text style={[s.tabText, (screen.name === k || (k === 'clients' && screen.name === 'client')) && s.tabOn]}>{l}</Text></Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

function VisitRow({ v, client, onPress, openActions }: { v: Row; client?: string; onPress: () => void; openActions: number }) {
  const { c } = useTheme();
  const w = visitWhen(v);
  const late = isVisitLate(v);
  const stage = visitStage(v.status, openActions);
  const reportLate = isReportLate(v);
  const col = visitStatusColor(c, stage);
  const pills = [{ text: VISIT_STATUS[stage] ?? stage, color: col }, ...(late ? [{ text: 'En retard', color: c.late }] : []), ...(reportLate ? [{ text: 'CR à valider', color: c.late }] : []),
    ...(openActions > 0 ? [{ text: `${openActions} action${openActions > 1 ? 's' : ''} à faire`, color: c.accent }] : [])];
  // Par client : la date est le titre. Par date : le client est le titre, la date en dessous.
  return <Row onPress={onPress} stripe={late || reportLate ? c.late : col} pills={pills} tone={late || reportLate ? 'late' : undefined}
    title={client ?? w.main} sub={client ? w.main : (w.sub ? `${w.sub}${v.objective ? ' · ' + v.objective : ''}` : v.objective ?? undefined)} />;
}

/** Fiche client : informations (CRM, lecture seule), visites précédentes avec leur compte rendu, actions associées. */
function ClientScreen({ companyId, data, ctx, act, back, showDeleted, showFinished, openVisit, openAction, planVisit }: { companyId: string; data: Data; ctx: Ctx; act: Act; back: () => void; showDeleted: boolean; showFinished: boolean; openVisit: (id: string) => void; openAction: (id: string) => void; planVisit: (co: Row) => Promise<void> }) {
  const { s, c } = useTheme();
  const co: Row | undefined = data.companies.find(x => x.id === companyId);
  const [busy, setBusy] = useState(false);
  if (!co) return <><Btn small title="‹ Retour" onPress={back} /><Text style={s.muted}>Client introuvable.</Text></>;
  const all = data.visits.filter(v => v.company_id === companyId);
  const visits = all.filter(v => showDeleted || v.status !== 'deleted').sort((a, b) => String(b.planned_start ?? '').localeCompare(String(a.planned_start ?? '')));
  const hidden = all.length - visits.length;
  const actions = data.actions.filter(a => a.company_id === companyId && (showFinished || a.status === 'todo'));
  const addr = companyAddress(co);
  const info = [['Adresse', addr], ['Secteur', co.sector]].filter(([, val]) => val);
  return <>
    <View style={s.headerRow}>
      <Pressable onPress={back} accessibilityRole="button" style={s.backBtn}><Text style={s.link}>‹ Retour</Text></Pressable>
      <Text style={s.titleCenter} numberOfLines={1} accessibilityRole="header">{co.name}</Text>
      <View style={s.backBtn} />
    </View>
    <View style={[s.rowCard, { flexDirection: 'column', alignItems: 'stretch', gap: 4 }]}>
      {info.length === 0 && <Text style={s.muted}>Aucune information complémentaire dans le CRM.</Text>}
      {info.map(([k, val]) => <View key={String(k)} style={s.fact}><Text style={s.muted}>{k}</Text><Text style={[s.t, { flexShrink: 1, textAlign: 'right' }]}>{String(val)}</Text></View>)}
      <Text style={s.muted}>Source : CRM, lecture seule.</Text>
    </View>
    <Btn title="+ Planifier une visite" onPress={() => { if (busy) return; setBusy(true); void planVisit(co).finally(() => setBusy(false)); }} />

    <Label>Visites ({visits.length})</Label>
    {visits.length === 0 && <Text style={s.muted}>Aucune visite pour ce client.</Text>}
    {visits.map(v => {
      const r: Row | undefined = data.reports.find(x => x.visit_id === v.id);
      const open = data.actions.filter(a => a.visit_id === v.id && a.status === 'todo').length;
      return <View key={v.id} style={{ gap: 4 }}>
        <VisitRow v={v} onPress={() => openVisit(v.id)} openActions={open} />
        {r && r.summary ? <Text style={[s.note, { marginLeft: 6 }]} numberOfLines={4} accessibilityLabel={`Compte rendu ${r.status === 'validated' ? 'validé' : 'brouillon'}`}>
          <Text style={{ fontWeight: '700' }}>CR {r.status === 'validated' ? 'validé' : 'brouillon'} · </Text>{r.summary}</Text> : null}
      </View>;
    })}
    {hidden > 0 && <Text style={s.muted}>{hidden} visite{hidden > 1 ? 's' : ''} supprimée{hidden > 1 ? 's' : ''} masquée{hidden > 1 ? 's' : ''}.</Text>}

    <Label>Actions associées ({actions.length})</Label>
    {actions.length === 0 && <Text style={s.muted}>Aucune action à faire pour ce client.</Text>}
    {actions.map(a => {
      const late = isActionLate(a, todayStr());
      return <Pressable key={a.id} onPress={() => openAction(a.id)} accessibilityRole="button" accessibilityLabel={`Ouvrir l'action : ${a.title}`}
        style={[s.rowCard, late ? { borderLeftWidth: 6, borderLeftColor: c.late } : null]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.t}>{a.title}</Text>
          <Text style={[s.muted, late && { color: c.late, fontWeight: '600' }]}>{a.due_date ? fmtDate(a.due_date) : 'sans échéance'}{a.status === 'done' ? ' · terminée' : a.status === 'cancelled' ? ' · annulée' : ''}{late ? ' · en retard' : ''}</Text>
        </View><Text style={s.muted}>›</Text></Pressable>;
    })}
  </>;
}

function VisitScreen({ visitId, data, ctx, act, back, companyName, offline, openReport, openActions }: { visitId: string; data: Data; ctx: Ctx; act: Act; back: () => void; companyName: (id: string) => string; offline: boolean; openReport: () => void; openActions: () => void }) {
  const { s, c } = useTheme();
  const v: Row | undefined = data.visits.find(x => x.id === visitId);
  const report: Row | undefined = data.reports.find(r => r.visit_id === visitId);
  const [dictating, setDictating] = useState<string | null>(null);          // dictée en cours : une seule à la fois
  const [dictErr, setDictErr] = useState<{ id: string; msg: string }>();
  const [noteSheet, setNoteSheet] = useState<'none' | 'note' | 'internal'>('none');
  const [editing, setEditing] = useState<{ entity: 'note' | 'internal_note'; row: Row } | null>(null);
  const [actionSheet, setActionSheet] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'date' | 'address' | 'history' | 'nav'>('none');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const setDictError = (id: string, msg?: string) => setDictErr(msg ? { id, msg } : undefined);
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
  const visitNotes = data.notes.filter(n => n.visit_id === visitId);
  const internal = data.internalNotes.filter(n => n.visit_id === visitId);
  const reportOpen = ['in_progress', 'done', 'validated'].includes(v.status);
  const notesOpen = canEditVisitNotes(v.status);                               // notes durant visite figées une fois la visite terminée
  const visitActions = data.actions.filter(a => a.visit_id === visitId);
  const todoCount = visitActions.filter(a => a.status === 'todo').length, doneCount = visitActions.filter(a => a.status === 'done').length;
  const stage = visitStage(v.status, todoCount);
  const drafts = draftsOf(report);
  const reportState = !report ? { text: 'Non rédigé', color: c.stDone } : report.status === 'validated' ? { text: 'Validé', color: c.stValidated } : { text: 'Brouillon', color: c.stPlanned };
  const Icon = ({ label, onPress }: { label: string; onPress: () => void }) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={s.iconBtn}><Text style={s.iconText}>✎</Text></Pressable>);
  return <>
    <View style={s.headerRow}>
      <Pressable onPress={back} accessibilityRole="button" style={s.backBtn}><Text style={s.link}>‹ Retour</Text></Pressable>
      <Text style={s.titleCenter} numberOfLines={1} accessibilityRole="header">{companyName(v.company_id)}</Text>
      <View style={s.backBtn} />
    </View>
    <View style={[s.rowCard, { flexDirection: 'column', alignItems: 'stretch', gap: 4 }]}>
      <View style={s.fact}><Text style={s.muted}>Statut</Text><View style={{ flexDirection: 'row', gap: 6 }}><Pill text={VISIT_STATUS[stage] ?? stage} color={visitStatusColor(c, stage)} />{isVisitLate(v) && <Pill text="En retard" color={c.late} />}{isReportLate(v) && <Pill text="CR à valider" color={c.late} />}</View></View>
      <View style={s.fact}><Text style={s.muted}>Prévue</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
          <Text style={[s.t, { flexShrink: 1, textAlign: 'right' }, isVisitLate(v) && { color: c.late }]}>{v.planned_start ? fmtDateTime(v.planned_start) : 'non planifiée'}</Text>
          {canDate && <Icon label="Modifier la date prévue" onPress={() => setSheet('date')} />}
        </View></View>
      <View style={s.fact}><Text style={s.muted}>Commencée</Text><Text style={s.t}>{v.started_at ? fmtDateTime(v.started_at) : '—'}</Text></View>
      <View style={s.fact}><Text style={s.muted}>Fin du rendez-vous</Text><Text style={s.t}>{v.ended_at ? fmtDateTime(v.ended_at) : '—'}</Text></View>
      <View style={s.fact}><Text style={s.muted}>Adresse de la visite</Text>{canAddress && <Icon label="Modifier l'adresse de la visite" onPress={() => setSheet('address')} />}</View>
      {address
        ? <Pressable onPress={() => setSheet('nav')} accessibilityRole="link" accessibilityLabel="Ouvrir l'itinéraire"><Text style={[s.t, { color: c.accent, textDecorationLine: 'underline' }]}>{address}  ›</Text></Pressable>
        : <Text style={s.muted}>Aucune adresse{canAddress ? ' : touchez le crayon pour en saisir une.' : '.'}</Text>}
      <Pressable onPress={() => setSheet('history')} accessibilityRole="button" style={{ minHeight: 36, justifyContent: 'center' }}>
        <Text style={s.link}>Historique des modifications ({entries.length})</Text></Pressable>
    </View>
    {v.status === 'deleted' && <Text style={s.muted}>Cette visite est supprimée : elle est conservée mais n'est plus modifiable.</Text>}
    {mine && v.status === 'planned' && <Btn title="Visite organisée avec le client" onPress={() => setStatus('organized')} />}
    {mine && (v.status === 'planned' || v.status === 'organized') && <Btn title="Démarrer la visite" onPress={() => setStatus('in_progress', { started_at: new Date().toISOString() })} />}
    {mine && v.status === 'in_progress' && <Btn title="Fin du rendez-vous" onPress={() => visitNotes.length === 0 ? setConfirmEnd(true) : setStatus('done', { ended_at: new Date().toISOString() })} />}
    {mine && v.status === 'in_progress' && <Text style={s.muted}>Quand vous quittez le client. Il restera à valider le compte rendu et à faire les actions ; la visite sera « Terminée » quand tout sera fait.</Text>}
    {isReportLate(v) && <Text style={[s.muted, { color: c.late, fontWeight: '600' }]}>Compte rendu à valider depuis plus de {REPORT_LATE_DAYS} jours.</Text>}

    <Label>Notes durant visite</Label>
    {visitNotes.map(n => n.author_id === ctx.userId && notesOpen
      ? <Pressable key={n.id} onPress={() => setEditing({ entity: 'note', row: n })} accessibilityRole="button" accessibilityLabel="Modifier la note" style={[s.note, { flexDirection: 'row', gap: 8 }]}>
          <Text style={{ color: c.text, flex: 1 }}>{n.body}</Text><Text style={s.iconText}>✎</Text></Pressable>
      : <Text key={n.id} style={s.note}>{n.body}</Text>)}
    {mine && !notesOpen && v.status !== 'deleted' && <Text style={s.muted}>Le rendez-vous est terminé : les notes durant visite ne sont plus modifiables.</Text>}
    {mine && notesOpen && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <DictationControl id="notes" label="Notes durant visite" review active={dictating} setActive={setDictating} ctx={ctx} visitId={visitId} offline={offline}
        onText={text => act(() => ctx.engine.create('note', { visit_id: visitId, kind: 'voice', body: text }))} onError={setDictError} />
      {dictating !== 'notes' && <Btn small title="+ Ajouter une note" onPress={() => setNoteSheet('note')} />}
    </View>}
    {dictErr?.id === 'notes' && <Text style={s.err}>{dictErr.msg}</Text>}

    <Label>Notes internes</Label>
    <Text style={s.muted}>Partagées avec votre hiérarchie. Elles n'apparaissent pas dans le compte rendu et ne sont jamais envoyées à l'IA.</Text>
    {internal.map(n => (
      <Pressable key={n.id} disabled={n.author_id !== ctx.userId || !canEditInternalNote(v.status)} onPress={() => setEditing({ entity: 'internal_note', row: n })} accessibilityRole="button" accessibilityLabel={n.author_id === ctx.userId && canEditInternalNote(v.status) ? 'Modifier la note interne' : 'Note interne'}
        style={[s.note, { borderLeftWidth: 5, borderLeftColor: c.stPlanned, gap: 2 }]}>
        <View style={{ flexDirection: 'row', gap: 8 }}><Text style={{ color: c.text, flex: 1 }}>{n.body}</Text>{n.author_id === ctx.userId && canEditInternalNote(v.status) && <Text style={s.iconText}>✎</Text>}</View>
        <Text style={s.muted}>{n.author_id === ctx.userId ? 'Vous' : n.author_name}</Text>
      </Pressable>))}
    {v.status === 'validated' && internal.length > 0 && <Text style={s.muted}>Compte rendu validé : vous pouvez ajouter une note interne, les notes existantes ne se modifient plus.</Text>}
    {ctx.role === 'commercial' && v.status !== 'deleted' && <View style={{ flexDirection: 'row' }}><Btn small title="+ Ajouter une note interne" onPress={() => setNoteSheet('internal')} /></View>}

    <Label>Actions</Label>
    {visitActions.length > 0
      ? <Pressable onPress={openActions} accessibilityRole="button" accessibilityLabel="Voir les actions de la visite" style={s.rowCard}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.t}>Actions de la visite</Text>
            <Text style={s.muted}>{todoCount} à faire · {doneCount} terminée{doneCount > 1 ? 's' : ''}</Text>
          </View><Text style={s.muted}>›</Text></Pressable>
      : <Text style={s.muted}>Aucune action pour cette visite.</Text>}
    {drafts.length > 0 && <Text style={s.muted}>{drafts.length} action{drafts.length > 1 ? 's' : ''} prévue{drafts.length > 1 ? 's' : ''} : créée{drafts.length > 1 ? 's' : ''} à la validation du compte rendu.</Text>}
    {mine && reportOpen && <View style={{ flexDirection: 'row' }}><Btn small title="+ Ajouter une action" onPress={() => setActionSheet(true)} /></View>}

    <Label>Compte rendu</Label>
    {reportOpen
      ? <Pressable onPress={openReport} accessibilityRole="button" accessibilityLabel="Ouvrir le compte rendu" style={s.rowCard}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.t}>{mine && report?.status !== 'validated' ? (report ? 'Rédiger / corriger le compte rendu' : 'Rédiger le compte rendu') : 'Voir le compte rendu'}</Text>
            <Pill text={reportState.text} color={reportState.color} />
          </View><Text style={s.muted}>›</Text></Pressable>
      : <Text style={s.muted}>Le compte rendu sera disponible une fois la visite commencée.</Text>}

    {canDeleteVisit(ctx.role as UserRole, mine) && v.status !== 'deleted' && <>
      <Label>Suppression</Label>
      {todoCount > 0
        ? <Text style={s.muted}>Suppression impossible : {todoCount} action{todoCount > 1 ? 's' : ''} à faire. Terminez-les ou annulez-les d'abord.</Text>
        : <View style={{ flexDirection: 'row' }}><Btn small danger title="Supprimer la visite" onPress={() => setConfirmDelete(true)} /></View>}
    </>}
    <ConfirmSheet visible={confirmEnd} title="Terminer le rendez-vous sans note ?" confirmLabel="Fin du rendez-vous"
      message="Vous n'avez saisi aucune note durant la visite : la génération du compte rendu par l'IA s'appuie sur ces notes, et elles ne seront plus modifiables ensuite."
      onClose={() => setConfirmEnd(false)} onConfirm={() => { setConfirmEnd(false); setStatus('done', { ended_at: new Date().toISOString() }); }} />
    <ConfirmSheet visible={confirmDelete} title="Supprimer cette visite ?" danger confirmLabel="Supprimer la visite"
      message="La visite passe au statut « Supprimée » et est masquée par défaut. Elle reste consultable (interrupteur « Afficher les visites supprimées ») mais n'est plus modifiable, et ne peut pas être restaurée."
      onClose={() => setConfirmDelete(false)} onConfirm={() => { setConfirmDelete(false); void act(() => ctx.engine.update('visit', v.id, { status: 'deleted' })); back(); }} />
    <AddNoteSheet visible={noteSheet !== 'none'} title={noteSheet === 'internal' ? 'Note interne' : 'Note durant la visite'} label={noteSheet === 'internal' ? 'Nouvelle note interne' : 'Nouvelle note'}
      placeholder={noteSheet === 'internal' ? 'Information importante pour l\'équipe' : 'Ce qui se dit pendant la visite'}
      hint={noteSheet === 'internal' ? 'Partagée avec votre hiérarchie. Absente du compte rendu, jamais envoyée à l\'IA.' : 'Ces notes servent à rédiger le compte rendu (génération par IA comprise).'}
      onClose={() => setNoteSheet('none')}
      onAdd={text => { const k = noteSheet; setNoteSheet('none'); void act(() => k === 'internal'
        ? ctx.engine.create('internal_note', { visit_id: visitId, body: text })
        : ctx.engine.create('note', { visit_id: visitId, kind: 'text', body: text })); }} />
    <ActionSheet visible={actionSheet} visit={v} title="Nouvelle action" onClose={() => setActionSheet(false)}
      hint={report?.status === 'validated' ? 'Le compte rendu est validé : l\'action est créée tout de suite.' : 'Elle sera créée quand le compte rendu sera validé.'}
      onSave={a => { setActionSheet(false); void act(async () => addActionToVisit(ctx, v, await freshReport(ctx, visitId), a)); }} />
    <NoteEditSheet target={editing} onClose={() => setEditing(null)}
      onSave={text => { const t = editing!; setEditing(null); void act(() => ctx.engine.update(t.entity, t.row.id, { body: text })); }}
      onDelete={() => { const t = editing!; setEditing(null); void act(() => ctx.engine.remove(t.entity, t.row.id)); }} />
    <EditDateSheet visible={sheet === 'date'} initial={v.planned_start} onClose={() => setSheet('none')}
      onSave={d => { setSheet('none'); void act(() => ctx.engine.update('visit', v.id, { planned_start: d ? d.toISOString() : null })); }} />
    <EditAddressSheet visible={sheet === 'address'} initial={address} onClose={() => setSheet('none')}
      onSave={t => { setSheet('none'); void act(() => ctx.engine.update('visit', v.id, { location_text: t.trim() || null })); }} />
    <HistorySheet visible={sheet === 'history'} entries={entries} onClose={() => setSheet('none')} />
    <NavChooser address={address} visible={sheet === 'nav'} onClose={() => setSheet('none')} />
  </>;
}

/**
 * Écran du compte rendu : rédigé après (ou en fin de) visite, à part de la prise de notes. Génération par IA à partir des notes
 * durant visite (jamais des notes internes), puis correction et complément à la main ou à la voix, enfin validation.
 */
function ReportScreen({ visitId, data, ctx, act, back, companyName, offline, openActions }: { visitId: string; data: Data; ctx: Ctx; act: Act; back: () => void; companyName: (id: string) => string; offline: boolean; openActions: () => void }) {
  const { s, c } = useTheme();
  const v: Row | undefined = data.visits.find(x => x.id === visitId);
  const report: Row | undefined = data.reports.find(r => r.visit_id === visitId);
  const [f, setF] = useState<Record<string, string>>(() => pickFields(report));
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string>();
  const [ai, setAi] = useState<AiProposalResponse>();
  const [dictating, setDictating] = useState<string | null>(null);
  const [dictErr, setDictErr] = useState<{ id: string; msg: string }>();
  const [actionSheet, setActionSheet] = useState<{ index: number | null } | null>(null);     // ajout (null) ou modification d'une action prévue
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [noAction, setNoAction] = useState(!!report?.no_action);
  const setDictError = (id: string, msg?: string) => setDictErr(msg ? { id, msg } : undefined);
  const appendTo = (k: string, text: string) => setF(cur => ({ ...cur, [k]: cur[k] && cur[k]!.trim() ? `${cur[k]!.trimEnd()} ${text}` : text }));
  useEffect(() => { if (report) setF(cur => (Object.values(cur).some(x => x) ? cur : pickFields(report))); }, [report?.id]);
  if (!v) return <><Btn small title="‹ Retour" onPress={back} /><Text style={s.muted}>Visite introuvable (supprimée ou plus accessible).</Text></>;
  const mine = v.author_id === ctx.userId;
  const validated = report?.status === 'validated';
  const notesText = data.notes.filter(n => n.visit_id === visitId && n.body).map(n => n.body).join('\n');   // notes durant visite seulement
  const inEndPhase = v.status === 'in_progress' || v.status === 'done';
  const canGenerate = mine && inEndPhase && !validated && !!notesText.trim() && !offline;
  const drafts = draftsOf(report);
  const visitActions = data.actions.filter(a => a.visit_id === visitId);
  const todoCount = visitActions.filter(a => a.status === 'todo').length, doneCount = visitActions.filter(a => a.status === 'done').length;
  const noActionAsked = drafts.length === 0 && visitActions.length === 0;      // sinon : des actions existent ou sont prévues
  const canValidate = canValidateReport(v.status) && (f.summary ?? '').trim().length > 0 && !validated && (!noActionAsked || noAction);
  const saveDrafts = (list: DraftAction[]) => act(async () => {
    const cur = await freshReport(ctx, visitId);
    if (cur) await ctx.engine.update('report', cur.id, { draft_actions: list });
    else await ctx.engine.create('report', { visit_id: visitId, language: ctx.lang, draft_actions: list, status: 'draft' });
  });
  const whyNot = !mine ? undefined : !inEndPhase && !validated ? 'La génération est possible une fois la visite commencée.' : validated ? 'Le compte rendu est validé.' : offline ? 'Hors-ligne : la génération par IA demande une connexion.' : !notesText.trim() ? 'Ajoutez des notes durant visite pour pouvoir générer le compte rendu.' : undefined;
  const hasContent = Object.values(f).some(x => x.trim());
  const state = !report ? { text: 'Non rédigé', color: c.stDone } : validated ? { text: 'Validé', color: c.stValidated } : { text: 'Brouillon', color: c.stPlanned };

  const saveReport = (validate: boolean, values: Record<string, string> = f) => act(async () => {
    const st = validate ? 'validated' : 'draft';
    const cur = await freshReport(ctx, visitId);
    const na = noActionAsked && noAction;
    if (!cur) await ctx.engine.create('report', { visit_id: visitId, language: ctx.lang, ...values, no_action: na, status: st });
    else await ctx.engine.update('report', cur.id, { ...values, no_action: na, ...(validate ? { status: st } : {}) });
  });
  // Génération par IA : le compte rendu doit exister sur le serveur ; on le crée en brouillon et on synchronise d'abord.
  const generate = async () => {
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
    const merged = { ...f, ...Object.fromEntries(Object.entries(fields).filter(([, x]) => x.trim())) };   // un champ vide proposé n'efface rien
    setF(merged); setAi(undefined);
    // Les actions proposées deviennent des actions PRÉVUES du brouillon : elles ne sont créées qu'à la validation du compte rendu.
    void act(async () => {
      const cur = await freshReport(ctx, visitId);
      const planned = [...draftsOf(cur), ...actions.map(a => ({ id: uuidv4(), title: a.title, due_date: a.due_date, origin: 'ai' as const }))];
      if (cur) await ctx.engine.update('report', cur.id, { ...merged, draft_actions: planned });
      else await ctx.engine.create('report', { visit_id: visitId, language: ctx.lang, ...merged, draft_actions: planned, status: 'draft' });
    });
  };

  return <>
    <View style={s.headerRow}>
      <Pressable onPress={back} accessibilityRole="button" style={s.backBtn}><Text style={s.link}>‹ Retour</Text></Pressable>
      <Text style={s.titleCenter} numberOfLines={1} accessibilityRole="header">Compte rendu</Text>
      <View style={s.backBtn} />
    </View>
    <View style={[s.rowCard, { flexDirection: 'column', alignItems: 'stretch', gap: 6 }]}>
      <View style={s.fact}><Text style={s.muted}>Visite</Text><Text style={s.t}>{companyName(v.company_id)}</Text></View>
      <View style={s.fact}><Text style={s.muted}>Statut du compte rendu</Text><Pill text={state.text} color={state.color} /></View>
    </View>
    {mine && <>
      <Btn title={aiBusy ? 'Génération en cours…' : 'Générer à partir des notes (IA)'} disabled={aiBusy || !canGenerate} onPress={generate} />
      <Text style={s.muted}>{whyNot ?? 'Utilise les notes durant visite, jamais les notes internes. Vous relisez avant d\'appliquer.'}</Text>
      {aiErr && <Text style={s.err}>{aiErr}</Text>}
    </>}
    {REPORT_FIELDS.map(([k, label]) => (
      <View key={k} style={{ gap: 4 }}>
        <View style={s.rowBetween}>
          <Text style={s.muted}>{label}</Text>
          {mine && !validated && <DictationControl compact id={`field:${k}`} label={label} active={dictating} setActive={setDictating} ctx={ctx} visitId={visitId} offline={offline}
            onText={text => appendTo(k, text)} onError={setDictError} />}
        </View>
        {dictErr?.id === `field:${k}` && <Text style={s.err}>{dictErr.msg}</Text>}
        <TextInput accessibilityLabel={k === 'summary' ? 'Résumé du compte rendu' : label} placeholderTextColor={c.muted} style={[s.input, { minHeight: k === 'summary' ? 90 : 60 }]}
          value={f[k] ?? ''} onChangeText={t => setF(cur => ({ ...cur, [k]: t }))} multiline editable={mine && !validated} />
      </View>))}

    <Label>{validated ? 'Actions' : 'Actions à créer à la validation'}</Label>
    {validated
      ? <Text style={s.muted}>Compte rendu validé : les actions ont été créées.</Text>
      : <Text style={s.muted}>Elles ne deviennent de vraies actions que lorsque le compte rendu est validé.</Text>}
    {!validated && drafts.map((d, i) => (
      <Pressable key={d.id} disabled={!mine} onPress={() => setActionSheet({ index: i })} accessibilityRole="button" accessibilityLabel={`Modifier l'action prévue : ${d.title}`} style={[s.note, { flexDirection: 'row', gap: 8 }]}>
        <View style={{ flex: 1 }}><Text style={{ color: c.text }}>{d.title}</Text><Text style={s.muted}>{d.due_date ? fmtDate(d.due_date) : 'sans échéance'}{d.origin === 'ai' ? ' · proposée par l\'IA' : ''}</Text></View>
        {mine && <Text style={s.iconText}>✎</Text>}
      </Pressable>))}
    {mine && !validated && <View style={{ flexDirection: 'row' }}><Btn small title="+ Ajouter une action" onPress={() => setActionSheet({ index: null })} /></View>}
    {mine && !validated && noActionAsked && <Pressable onPress={() => setNoAction(x => !x)} accessibilityRole="checkbox" accessibilityState={{ checked: noAction }} accessibilityLabel="Aucune action à prévoir" style={[s.rowCard, { gap: 10 }]}>
      <View style={[s.box, noAction && { backgroundColor: c.accent, borderColor: c.accent }]}>{noAction && <Text style={{ color: c.accentInk, fontWeight: '700' }}>✓</Text>}</View>
      <Text style={[s.t, { flex: 1 }]}>Aucune action à prévoir</Text></Pressable>}
    {visitActions.length > 0 && <Pressable onPress={openActions} accessibilityRole="button" accessibilityLabel="Voir les actions de la visite" style={s.rowCard}>
      <View style={{ flex: 1, gap: 2 }}><Text style={s.t}>Actions de la visite</Text><Text style={s.muted}>{todoCount} à faire · {doneCount} terminée{doneCount > 1 ? 's' : ''}</Text></View><Text style={s.muted}>›</Text></Pressable>}

    {mine && !validated && <>
      <View style={s.rowBetween}>
        <Btn small title="Enregistrer" disabled={!hasContent && !report} onPress={() => saveReport(false)} />
        <Btn small title="Valider le compte rendu" disabled={!canValidate} onPress={() => saveReport(true)} />
      </View>
      {!canValidateReport(v.status) && <Text style={s.muted}>Terminez le rendez-vous (« Fin du rendez-vous ») pour pouvoir valider le compte rendu.</Text>}
      {canValidateReport(v.status) && noActionAsked && !noAction && <Text style={s.muted}>Ajoutez une action ou cochez « Aucune action à prévoir » pour valider.</Text>}
    </>}
    {mine && validated && !report?.sent_to_client_at && <>
      <Text style={s.muted}>Un compte rendu validé n'est plus modifiable. Pour le corriger, remettez-le en brouillon : la visite repassera à « Effectuée ».</Text>
      <Btn small title="Remettre en brouillon" onPress={() => setConfirmReopen(true)} />
    </>}
    {mine && validated && !!report?.sent_to_client_at && <Text style={s.muted}>Compte rendu transmis au client : il ne peut plus être remis en brouillon.</Text>}
    {!mine && <Text style={s.muted}>Seul l'auteur de la visite modifie le compte rendu.</Text>}
    <ConfirmSheet visible={confirmReopen} title="Remettre le compte rendu en brouillon ?" confirmLabel="Remettre en brouillon"
      message="Le compte rendu redeviendra modifiable et la visite repassera à « Effectuée ». Les actions déjà créées sont conservées ; à la prochaine validation, seules les nouvelles actions prévues seront créées."
      onClose={() => setConfirmReopen(false)} onConfirm={() => { setConfirmReopen(false); void act(async () => { const cur = await freshReport(ctx, visitId); if (cur) await ctx.engine.update('report', cur.id, { status: 'draft' }); }); }} />
    <ActionSheet visible={!!actionSheet} visit={v} title={actionSheet?.index === null ? 'Nouvelle action prévue' : 'Modifier l\'action prévue'}
      initial={actionSheet && actionSheet.index !== null ? drafts[actionSheet.index] : undefined} hint="Créée à la validation du compte rendu."
      onClose={() => setActionSheet(null)}
      onSave={a => { const i = actionSheet!.index; setActionSheet(null); void saveDrafts(i === null ? [...drafts, { id: uuidv4(), title: a.title, due_date: a.due_date, origin: 'manual' }] : drafts.map((d, j) => j === i ? { ...d, ...a } : d)); }} />
    <AiSheet result={ai} onClose={() => setAi(undefined)} onApply={applyAi} />
  </>;
}

interface DraftAction { id: string; title: string; due_date: string | null; origin: 'ai' | 'manual' }
/** Compte rendu d'une visite relu dans le stockage local au moment d'agir : l'écran peut afficher une version plus ancienne. */
const freshReport = async (ctx: Ctx, visitId: string): Promise<Row | undefined> => (await ctx.store.list('reports')).find(r => r.visit_id === visitId);
const draftsOf = (report?: Row): DraftAction[] => (Array.isArray(report?.draft_actions) ? (report!.draft_actions as DraftAction[]) : []);

/**
 * Ajout d'une action depuis une visite. Une action n'existe qu'une fois le compte rendu validé : avant, elle est seulement « prévue »
 * dans le brouillon du compte rendu et sera créée par le serveur à la validation ; après, elle est créée tout de suite.
 */
async function addActionToVisit(ctx: Ctx, v: Row, report: Row | undefined, a: { title: string; due_date: string | null }) {
  if (report?.status === 'validated') {
    await ctx.engine.create('action', { company_id: v.company_id, visit_id: v.id, title: a.title, origin: 'manual', ...(a.due_date ? { due_date: a.due_date } : {}) });
    return;
  }
  const list = [...draftsOf(report), { id: uuidv4(), title: a.title, due_date: a.due_date, origin: 'manual' as const }];
  if (report) await ctx.engine.update('report', report.id, { draft_actions: list });
  else await ctx.engine.create('report', { visit_id: v.id, language: ctx.lang, draft_actions: list, status: 'draft' });
}

/** Fenêtre d'ajout ou de modification d'une action (intitulé et échéance). */
function ActionSheet({ visible, visit, title, initial, hint, onClose, onSave }: { visible: boolean; visit?: Row; title: string; initial?: { title: string; due_date: string | null }; hint?: string; onClose: () => void; onSave: (a: { title: string; due_date: string | null }) => void }) {
  const { s, c } = useTheme();
  const [text, setText] = useState(''); const [due, setDue] = useState<Date | undefined>();
  useEffect(() => { if (visible) { setText(initial?.title ?? ''); setDue(strToDate(initial?.due_date)); } }, [visible]);
  const tooEarly = !!due && !!visit && isDueBeforeVisit(dateToStr(due), visit);
  return (
    <Sheet title={title} visible={visible} onClose={onClose}>
      <Label>Intitulé</Label>
      <TextInput accessibilityLabel="Intitulé de l'action" placeholderTextColor={c.muted} style={s.input} value={text} onChangeText={setText} placeholder="Ex. Envoyer le devis" />
      <Label>Échéance</Label>
      <DateField label="Échéance de l'action" mode="date" value={due} onChange={setDue} clearable />
      {hint ? <Text style={s.muted}>{hint}</Text> : null}
      {tooEarly && <Text style={s.err}>L'échéance est antérieure à la date de la visite.</Text>}
      <Btn title="Enregistrer" disabled={!text.trim() || tooEarly} onPress={() => onSave({ title: text.trim(), due_date: due ? dateToStr(due) : null })} />
      <Btn small title="Annuler" onPress={onClose} />
    </Sheet>
  );
}

/** Confirmation en deux temps dans une fenêtre (les boîtes de dialogue du système ne servent pas sur le web). */
function ConfirmSheet({ visible, title, message, confirmLabel, danger, onConfirm, onClose }: { visible: boolean; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  const { s } = useTheme();
  return (
    <Sheet title={title} visible={visible} onClose={onClose}>
      <Text style={s.muted}>{message}</Text>
      <Btn title={confirmLabel} danger={danger} onPress={onConfirm} />
      <Btn small title="Annuler" onPress={onClose} />
    </Sheet>
  );
}

/** Ajout d'une note (durant visite ou interne) dans une fenêtre, pour garder l'écran léger. */
function AddNoteSheet({ visible, title, label, placeholder, hint, onClose, onAdd }: { visible: boolean; title: string; label: string; placeholder: string; hint: string; onClose: () => void; onAdd: (text: string) => void }) {
  const { s, c } = useTheme();
  const [text, setText] = useState('');
  useEffect(() => { if (visible) setText(''); }, [visible]);
  return (
    <Sheet title={title} visible={visible} onClose={onClose}>
      <TextInput accessibilityLabel={label} placeholderTextColor={c.muted} style={[s.input, { minHeight: 110 }]} value={text} onChangeText={setText} placeholder={placeholder} multiline />
      <Text style={s.muted}>{hint}</Text>
      <Btn title="Ajouter" disabled={!text.trim()} onPress={() => onAdd(text.trim())} />
      <Btn small title="Annuler" onPress={onClose} />
    </Sheet>
  );
}

/** Modification d'une note ; suppression en deux temps (confirmation dans la fenêtre : les boîtes de dialogue du système ne servent pas sur le web). */
function NoteEditSheet({ target, onClose, onSave, onDelete }: { target: { entity: 'note' | 'internal_note'; row: Row } | null; onClose: () => void; onSave: (text: string) => void; onDelete: () => void }) {
  const { s, c } = useTheme();
  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (target) { setText((target.row.body as string) ?? ''); setConfirming(false); } }, [target]);
  const internalNote = target?.entity === 'internal_note';
  return (
    <Sheet title={confirming ? 'Supprimer cette note ?' : internalNote ? 'Modifier la note interne' : 'Modifier la note'} visible={!!target} onClose={onClose}>
      {confirming ? <>
        <Text style={s.t}>{text.length > 120 ? `${text.slice(0, 120)}…` : text}</Text>
        <Text style={s.muted}>La suppression est définitive.</Text>
        <Btn title="Confirmer la suppression" danger onPress={onDelete} />
        <Btn small title="Annuler" onPress={() => setConfirming(false)} />
      </> : <>
        <TextInput accessibilityLabel="Texte de la note" placeholderTextColor={c.muted} style={[s.input, { minHeight: 110 }]} value={text} onChangeText={setText} multiline />
        <Btn title="Enregistrer" disabled={!text.trim() || text.trim() === ((target?.row.body as string) ?? '').trim()} onPress={() => onSave(text.trim())} />
        <Btn small title="Supprimer la note" danger onPress={() => setConfirming(true)} />
        <Btn small title="Annuler" onPress={onClose} />
      </>}
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

const EVENT_LABEL: Record<string, string> = { report_validated: 'Compte rendu validé', report_reopened: 'Compte rendu remis en brouillon', visit_deleted: 'Visite supprimée' };

function HistorySheet({ visible, entries, onClose }: { visible: boolean; entries: Row[]; onClose: () => void }) {
  const { s } = useTheme();
  const val = (e: Row, v?: string | null) => !v ? '—' : e.field === 'planned_start' ? fmtDateTime(v) : v;
  return (
    <Sheet title="Historique des modifications" visible={visible} onClose={onClose}>
      {entries.length === 0 && <Text style={s.muted}>Aucune modification depuis la création de la visite.</Text>}
      {entries.map(e => (
        <View key={e.id} style={s.hist}>
          <Text style={s.t}>{EVENT_LABEL[e.field] ?? (e.field === 'planned_start' ? 'Date prévue' : 'Adresse de la visite')}</Text>
          <Text style={s.muted}>{fmtDateTime(e.changed_at)} · {e.changed_by_name}</Text>
          {!EVENT_LABEL[e.field] && <Text style={{ color: s.t.color }}>{val(e, e.old_value)}  →  {val(e, e.new_value)}</Text>}
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
      <Text style={s.muted}>Proposé par l'IA : relisez et corrigez avant d'appliquer. Rien n'est enregistré tant que vous n'appliquez pas. Les champs proposés remplacent ceux du compte rendu ; un champ proposé vide n'efface rien.</Text>
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

/** Modification d'une action existante (elles naissent toutes d'une visite : pas de création depuis cet écran). */
function ActionForm({ id, data, ctx, act, back, companyName, openVisit }: { id: string; data: Data; ctx: Ctx; act: Act; back: () => void; companyName: (id: string) => string; openVisit: (id: string) => void }) {
  const { s, c } = useTheme();
  const existing: Row | undefined = data.actions.find(a => a.id === id);
  const [title, setTitle] = useState(existing?.title ?? ''); const [due, setDue] = useState<Date | undefined>(strToDate(existing?.due_date));
  if (!existing) return <><Btn small title="‹ Retour" onPress={back} /><Text style={s.muted}>Action introuvable.</Text></>;
  const visit = data.visits.find(v => v.id === existing.visit_id);
  const tooEarly = !!due && !!visit && isDueBeforeVisit(dateToStr(due), visit);
  return <>
    <Btn small title="‹ Retour" onPress={back} />
    <Text style={s.h1}>Modifier l'action</Text>
    <Text style={s.muted}>Client : {companyName(existing.company_id)}</Text>
    {visit && <Btn small title="Ouvrir la visite" onPress={() => openVisit(visit.id)} />}
    <Label>Intitulé</Label><TextInput accessibilityLabel="Intitulé de l'action" placeholderTextColor={c.muted} style={s.input} value={title} onChangeText={setTitle} />
    <Label>Échéance</Label><DateField label="Échéance" mode="date" value={due} onChange={setDue} clearable />
    <Text style={s.muted}>Responsable : vous.</Text>
    {tooEarly && <Text style={s.err}>L'échéance est antérieure à la date de la visite.</Text>}
    <Btn title="Enregistrer" disabled={!title.trim() || tooEarly} onPress={() => act(async () => {
      await ctx.engine.update('action', existing.id, { title: title.trim(), due_date: due ? dateToStr(due) : null });
      back();
    })} />
    {existing.status !== 'cancelled' && <Btn title="Annuler l'action" onPress={() => act(async () => { await ctx.engine.update('action', existing.id, { status: 'cancelled' }); back(); })} />}
  </>;
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  const { s } = useTheme();
  return <View style={s.seg} accessibilityRole="radiogroup">{options.map(([k, l]) => (
    <Pressable key={k} accessibilityRole="radio" accessibilityState={{ selected: value === k }} onPress={() => onChange(k)} style={[s.segBtn, value === k && s.segOn]}>
      <Text style={[s.segText, value === k && s.segTextOn]}>{l}</Text></Pressable>))}</View>;
}
const Label = ({ children }: { children: React.ReactNode }) => { const { s } = useTheme(); return <Text style={s.label}>{children}</Text>; };
const Btn = ({ title, onPress, disabled, small, danger }: { title: string; onPress: () => void; disabled?: boolean; small?: boolean; danger?: boolean }) => {
  const { s, c } = useTheme();
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={[s.btn, small && s.btnSmall, danger && { backgroundColor: c.late }, disabled && s.btnOff]}><Text style={s.btnText}>{title}</Text></Pressable>;
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
