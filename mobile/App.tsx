import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Crypto from 'expo-crypto';
import { ApiClient, SyncEngine, type Row, type SyncReport } from '@visites/sync-core';
import { openStore } from './src/expoDb';
import type { SqliteStore } from '@visites/sync-core';
import { clearSession, loadSession, saveSession, saveTokens, type Session } from './src/session';

// Prototype : écrans minimaux pour exercer la synchro. La dictée vocale et l'IA ne sont PAS implémentées.
const APP_VERSION = '0.1.0';
const DEFAULT_SERVER = 'http://10.0.2.2:3000/api/mobile/v1';   // 10.0.2.2 = machine hôte depuis l'émulateur Android

type Screen = { name: 'today' } | { name: 'visit'; id: string } | { name: 'clients' } | { name: 'actions' } | { name: 'action'; id?: string } | { name: 'settings' };

interface Ctx { store: SqliteStore; engine: SyncEngine; client: ApiClient; userId: string; refresh: () => void }

export default function App() {
  const [boot, setBoot] = useState<'loading' | 'login' | 'ready'>('loading');
  const [ctx, setCtx] = useState<Ctx>();
  const storeRef = useRef<SqliteStore>();

  const start = useCallback(async (s: Session, onTokens: (t: Session['tokens'] | undefined) => void) => {
    storeRef.current ??= await openStore();
    const store = storeRef.current;
    const client = new ApiClient(s.server, APP_VERSION, s.tokens, t => { void saveTokens(t); onTokens(t); });
    const engine = new SyncEngine(store, client, { newId: () => Crypto.randomUUID(), userId: s.userId });
    setCtx({ store, engine, client, userId: s.userId, refresh: () => {} });
    setBoot('ready');
  }, []);

  useEffect(() => { (async () => {
    const s = await loadSession();
    if (!s) return setBoot('login');
    await start(s, t => { if (!t) { setBoot('login'); } });
  })().catch(() => setBoot('login')); }, [start]);

  const logout = useCallback(async () => {
    try { await ctx?.client['call']('POST', '/auth/logout'); } catch { /* hors-ligne : la révocation côté serveur aura lieu plus tard */ }
    await storeRef.current?.wipe();    // plus aucune donnée sur l'appareil
    await clearSession(); setCtx(undefined); setBoot('login');
  }, [ctx]);

  if (boot === 'loading') return <Center><ActivityIndicator /></Center>;
  if (boot === 'login' || !ctx) return <Login onDone={async (s) => { await saveSession(s); await start(s, () => {}); }} />;
  return <Main ctx={ctx} onLogout={logout} />;
}

function Login({ onDone }: { onDone: (s: Session) => Promise<void> }) {
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(undefined);
    try {
      const client = new ApiClient(server, APP_VERSION, undefined);
      const tokens = await client.login(email.trim(), password, Platform.OS === 'ios' ? 'ios' : 'android');
      const me = await client.me();
      await onDone({ server, userId: me.id, tokens });
    } catch (e: any) {
      setErr(e.code === 'invalid_credentials' ? 'Identifiants incorrects.' : e.code === 'account_locked' ? 'Compte verrouillé, réessayez plus tard.'
        : e.code === 'upgrade_required' ? 'Mettez l\'application à jour.' : 'Connexion impossible. Vérifiez le réseau et l\'adresse du serveur.');
    } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={s.page}><View style={s.pad}>
      <Text style={s.h1}>Visites commerciales</Text>
      <Label>Adresse du serveur</Label><TextInput style={s.input} value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} />
      <Label>E-mail</Label><TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      <Label>Mot de passe</Label><TextInput style={s.input} value={password} onChangeText={setPassword} secureTextEntry />
      {err ? <Text style={s.err}>{err}</Text> : null}
      <Btn title={busy ? 'Connexion…' : 'Se connecter'} onPress={submit} disabled={busy || !email || !password} />
    </View></SafeAreaView>
  );
}

function Main({ ctx, onLogout }: { ctx: Ctx; onLogout: () => void }) {
  const [screen, setScreen] = useState<Screen>({ name: 'today' });
  const [data, setData] = useState<{ visits: Row[]; companies: Row[]; actions: Row[]; reports: Row[]; notes: Row[]; pending: number }>({ visits: [], companies: [], actions: [], reports: [], notes: [], pending: 0 });
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

  const act = async (fn: () => Promise<unknown>) => { await fn(); await load(); void sync(); };
  const companyName = (id: string) => data.companies.find(c => c.id === id)?.name ?? '…';

  return (
    <SafeAreaView style={s.page}>
      <StatusBar style="auto" />
      <View style={[s.bar, status.offline && s.barOff]}>
        <Text style={s.barText}>{status.offline ? 'Hors-ligne' : 'Synchronisé'}{data.pending ? ` · ${data.pending} en attente` : ''}{status.msg ? ` · ${status.msg}` : ''}</Text>
        <Pressable onPress={() => void sync()} accessibilityRole="button"><Text style={s.link}>Synchroniser</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={s.pad}>
        {screen.name === 'today' && <>
          <Text style={s.h1}>Visites</Text>
          {data.visits.length === 0 && <Text style={s.muted}>Aucune visite. Créez-en une depuis un client.</Text>}
          {[...data.visits].sort((a, b) => String(a.planned_start ?? a.updated_at).localeCompare(String(b.planned_start ?? b.updated_at))).map(v => (
            <Row key={v.id} onPress={() => setScreen({ name: 'visit', id: v.id })} title={companyName(v.company_id)} sub={`${v.status}${v.objective ? ' · ' + v.objective : ''}`} />
          ))}
        </>}
        {screen.name === 'clients' && <>
          <Text style={s.h1}>Clients</Text>
          <Text style={s.muted}>Source : CRM, lecture seule.</Text>
          {data.companies.filter(c => c.status === 'active').map(c => (
            <Row key={c.id} title={c.name} sub={[c.city, c.sector].filter(Boolean).join(' · ')}
              onPress={() => act(async () => { const id = await ctx.engine.create('visit', { company_id: c.id, status: 'planned', planned_start: new Date().toISOString() }); setScreen({ name: 'visit', id }); })} />
          ))}
          <Text style={s.muted}>Toucher un client crée une visite.</Text>
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

function VisitScreen({ visitId, data, ctx, act, back, companyName }: { visitId: string; data: any; ctx: Ctx; act: (f: () => Promise<unknown>) => Promise<void>; back: () => void; companyName: (id: string) => string }) {
  const v: Row | undefined = data.visits.find((x: Row) => x.id === visitId);
  const report: Row | undefined = data.reports.find((r: Row) => r.visit_id === visitId);
  const [summary, setSummary] = useState<string>(report?.summary ?? '');
  const [note, setNote] = useState('');
  if (!v) return <><Btn small title="‹ Retour" onPress={back} /><Text style={s.muted}>Visite introuvable (supprimée ou plus accessible).</Text></>;
  const mine = v.author_id === ctx.userId;
  const saveReport = (validate: boolean) => act(async () => {
    const status = validate ? 'validated' : 'draft';
    if (!report) await ctx.engine.create('report', { visit_id: visitId, language: 'fr', summary, status });
    else await ctx.engine.update('report', report.id, { summary, ...(validate ? { status } : {}) });
  });
  return <>
    <Btn small title="‹ Retour" onPress={back} />
    <Text style={s.h1}>{companyName(v.company_id)}</Text>
    <Text style={s.muted}>Statut : {v.status}</Text>
    {mine && <View style={s.rowBetween}>
      {v.status === 'planned' && <Btn title="Démarrer" onPress={() => act(() => ctx.engine.update('visit', v.id, { status: 'in_progress', started_at: new Date().toISOString() }))} />}
      {v.status === 'in_progress' && <Btn title="Terminer" onPress={() => act(() => ctx.engine.update('visit', v.id, { status: 'done', ended_at: new Date().toISOString() }))} />}
    </View>}
    <Label>Notes</Label>
    {data.notes.filter((n: Row) => n.visit_id === visitId).map((n: Row) => <Text key={n.id} style={s.note}>{n.body}</Text>)}
    {mine && <><TextInput style={s.input} value={note} onChangeText={setNote} placeholder="Nouvelle note" multiline />
      <Btn small title="Ajouter" disabled={!note.trim()} onPress={() => act(async () => { await ctx.engine.create('note', { visit_id: visitId, kind: 'text', body: note.trim() }); setNote(''); })} /></>}
    <Label>Compte rendu {report?.status === 'validated' ? '(validé)' : ''}</Label>
    <TextInput style={[s.input, { minHeight: 110 }]} value={summary} onChangeText={setSummary} multiline editable={mine} placeholder="Résumé de la visite" />
    <Text style={s.muted}>Saisie manuelle. La dictée vocale et l'IA ne sont pas disponibles dans ce prototype.</Text>
    {mine && <View style={s.rowBetween}>
      <Btn small title="Enregistrer" onPress={() => saveReport(false)} />
      <Btn small title="Valider" disabled={!summary.trim() || report?.status === 'validated'} onPress={() => saveReport(true)} />
    </View>}
  </>;
}

function ActionForm({ id, data, ctx, act, back }: { id?: string; data: any; ctx: Ctx; act: (f: () => Promise<unknown>) => Promise<void>; back: () => void }) {
  const existing: Row | undefined = id ? data.actions.find((a: Row) => a.id === id) : undefined;
  const [title, setTitle] = useState(existing?.title ?? ''); const [due, setDue] = useState(existing?.due_date ?? '');
  const [company, setCompany] = useState<string>(existing?.company_id ?? data.companies[0]?.id ?? '');
  const valid = title.trim().length > 0 && (!due || /^\d{4}-\d{2}-\d{2}$/.test(due)) && !!company;
  return <>
    <Btn small title="‹ Retour" onPress={back} />
    <Text style={s.h1}>{existing ? 'Modifier l\'action' : 'Nouvelle action'}</Text>
    <Label>Intitulé</Label><TextInput style={s.input} value={title} onChangeText={setTitle} />
    <Label>Client</Label>
    {data.companies.map((c: Row) => <Pressable key={c.id} onPress={() => !existing && setCompany(c.id)} style={[s.choice, company === c.id && s.choiceOn]}><Text>{c.name}</Text></Pressable>)}
    <Label>Échéance (AAAA-MM-JJ)</Label><TextInput style={s.input} value={due} onChangeText={setDue} placeholder="2026-11-26" autoCapitalize="none" />
    <Text style={s.muted}>Responsable : vous.</Text>
    <Btn title="Enregistrer" disabled={!valid} onPress={() => act(async () => {
      if (existing) await ctx.engine.update('action', existing.id, { title: title.trim(), due_date: due || null });
      else await ctx.engine.create('action', { company_id: company, title: title.trim(), ...(due ? { due_date: due } : {}), origin: 'manual' });
      back();
    })} />
    {existing && existing.status !== 'cancelled' && <Btn title="Annuler l'action" onPress={() => act(async () => { await ctx.engine.update('action', existing.id, { status: 'cancelled' }); back(); })} />}
  </>;
}

const Center = ({ children }: { children: React.ReactNode }) => <View style={[s.page, { alignItems: 'center', justifyContent: 'center' }]}>{children}</View>;
const Label = ({ children }: { children: React.ReactNode }) => <Text style={s.label}>{children}</Text>;
const Btn = ({ title, onPress, disabled, small }: { title: string; onPress: () => void; disabled?: boolean; small?: boolean }) => (
  <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={[s.btn, small && s.btnSmall, disabled && s.btnOff]}><Text style={s.btnText}>{title}</Text></Pressable>
);
const Row = ({ title, sub, onPress }: { title: string; sub?: string; onPress: () => void }) => (
  <Pressable onPress={onPress} style={s.rowCard} accessibilityRole="button"><View style={{ flex: 1 }}><Text style={s.t}>{title}</Text>{sub ? <Text style={s.muted}>{sub}</Text> : null}</View><Text style={s.muted}>›</Text></Pressable>
);

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F4F6F5' }, pad: { padding: 16, gap: 10 },
  h1: { fontSize: 24, fontWeight: '700', color: '#14212B' }, t: { fontSize: 16, fontWeight: '600', color: '#14212B' },
  muted: { color: '#5B6A74', fontSize: 13 }, label: { fontSize: 12, fontWeight: '600', color: '#5B6A74', textTransform: 'uppercase', marginTop: 6 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#D9DEDC', borderRadius: 12, padding: 12, minHeight: 48, fontSize: 16 },
  btn: { backgroundColor: '#0E6A87', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  btnSmall: { minHeight: 40, paddingVertical: 8, alignSelf: 'flex-start' }, btnOff: { opacity: 0.4 }, btnText: { color: '#fff', fontWeight: '600' },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#D9DEDC', minHeight: 56 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  bar: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#DDEFE4' },
  barOff: { backgroundColor: '#F7EACB' }, barText: { fontSize: 12, fontWeight: '600', color: '#14212B' }, link: { color: '#0E6A87', fontWeight: '600', fontSize: 12 },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: '#D9DEDC', backgroundColor: '#fff' }, tab: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  tabText: { fontSize: 12, fontWeight: '600', color: '#5B6A74' }, tabOn: { color: '#0E6A87' },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#5B6A74' }, boxOn: { backgroundColor: '#2B7A4B', borderColor: '#2B7A4B' },
  done: { textDecorationLine: 'line-through', color: '#5B6A74' }, err: { color: '#B3261E' },
  note: { backgroundColor: '#fff', borderRadius: 10, padding: 10 }, choice: { padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#D9DEDC', backgroundColor: '#fff' },
  choiceOn: { borderColor: '#0E6A87', backgroundColor: '#DCEDF3' },
});
