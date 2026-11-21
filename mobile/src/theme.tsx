import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, useColorScheme } from 'react-native';
import { loadTheme, saveTheme, type ThemePref } from './session';

export interface Palette {
  bg: string; surface: string; text: string; muted: string; line: string; accent: string; accentInk: string; accentSoft: string;
  okBg: string; warnBg: string; ok: string; err: string;
  stPlanned: string; stOrganized: string; stProgress: string; stDone: string; stValidated: string; stCancelled: string; late: string;
}
const light: Palette = { bg: '#F4F6F5', surface: '#FFFFFF', text: '#14212B', muted: '#5B6A74', line: '#D9DEDC', accent: '#0E6A87', accentInk: '#FFFFFF', accentSoft: '#DCEDF3', okBg: '#DDEFE4', warnBg: '#F7EACB', ok: '#2B7A4B', err: '#B3261E', stPlanned: '#A8680A', stOrganized: '#0E6A87', stProgress: '#2B7A4B', stDone: '#5B6A74', stValidated: '#5E4BB5', stCancelled: '#7C858B', late: '#C62828' };
const dark: Palette = { bg: '#0C1317', surface: '#152028', text: '#E7EDF0', muted: '#98A8B2', line: '#25333D', accent: '#4FB4D3', accentInk: '#06222C', accentSoft: '#12303B', okBg: '#173526', warnBg: '#3A2D10', ok: '#6CC58D', err: '#F2B8B5', stPlanned: '#E3B04B', stOrganized: '#4FB4D3', stProgress: '#6CC58D', stDone: '#98A8B2', stValidated: '#B6A1F0', stCancelled: '#7E8A92', late: '#FF8A80' };

function makeStyles(c: Palette) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: c.bg }, pad: { padding: 16, gap: 10 },
    h1: { fontSize: 24, fontWeight: '700', color: c.text }, h2: { fontSize: 15, fontWeight: '700', color: c.text },
    t: { fontSize: 16, fontWeight: '600', color: c.text },
    muted: { color: c.muted, fontSize: 13 }, label: { fontSize: 12, fontWeight: '600', color: c.muted, textTransform: 'uppercase', marginTop: 6 },
    input: { backgroundColor: c.surface, color: c.text, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12, minHeight: 48, fontSize: 16 },
    btn: { backgroundColor: c.accent, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    btnSmall: { minHeight: 40, paddingVertical: 8, alignSelf: 'flex-start' }, btnOff: { opacity: 0.4 }, btnText: { color: c.accentInk, fontWeight: '600' },
    rowCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: c.line, minHeight: 56 },
    rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
    group: { marginTop: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
    bar: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: c.okBg },
    barOff: { backgroundColor: c.warnBg }, barText: { fontSize: 12, fontWeight: '600', color: c.text }, link: { color: c.accent, fontWeight: '600', fontSize: 12 },
    tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: c.line, backgroundColor: c.surface }, tab: { flex: 1, paddingVertical: 14, alignItems: 'center' },
    tabText: { fontSize: 12, fontWeight: '600', color: c.muted }, tabOn: { color: c.accent },
    box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: c.muted }, boxOn: { backgroundColor: c.ok, borderColor: c.ok },
    done: { textDecorationLine: 'line-through', color: c.muted }, err: { color: c.err },
    note: { backgroundColor: c.surface, color: c.text, borderRadius: 10, padding: 10, overflow: 'hidden' },
    choice: { padding: 12, borderRadius: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface },
    choiceOn: { borderColor: c.accent, backgroundColor: c.accentSoft },
    seg: { flexDirection: 'row', backgroundColor: c.line, borderRadius: 10, padding: 3, gap: 3 },
    segBtn: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', minHeight: 40, justifyContent: 'center' },
    segOn: { backgroundColor: c.surface }, segText: { fontWeight: '600', fontSize: 13, color: c.muted }, segTextOn: { color: c.text },
    fact: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 28 },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
    backBtn: { width: 92, minHeight: 44, justifyContent: 'center' },
    titleCenter: { flex: 1, textAlign: 'center', fontSize: 20, fontWeight: '700', color: c.text },
    iconBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }, iconText: { fontSize: 20, color: c.accent },
    sheet: { backgroundColor: c.surface, padding: 16, gap: 10, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '85%' },
    pill: { borderRadius: 99, paddingHorizontal: 9, paddingVertical: 3, alignSelf: 'flex-start' }, pillText: { fontSize: 12, fontWeight: '700' },
    hist: { borderTopWidth: 1, borderColor: c.line, paddingTop: 8, gap: 2 },
  });
}
export type Styles = ReturnType<typeof makeStyles>;

interface ThemeValue { c: Palette; s: Styles; pref: ThemePref; setPref: (p: ThemePref) => void; dark: boolean }
const Ctx = createContext<ThemeValue>(undefined as unknown as ThemeValue);
export const useTheme = () => useContext(Ctx);

/** Thème : réglage du système par défaut, clair ou sombre au choix (conservé d'une session à l'autre). */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [pref, setPrefState] = useState<ThemePref>('system');
  useEffect(() => { void loadTheme().then(setPrefState); }, []);
  const dk = pref === 'system' ? system === 'dark' : pref === 'dark';
  const value = useMemo<ThemeValue>(() => {
    const c = dk ? dark : light;
    return { c, s: makeStyles(c), pref, dark: dk, setPref: p => { setPrefState(p); void saveTheme(p); } };
  }, [dk, pref]);
  useEffect(() => {
    if (Platform.OS === 'web') { document.documentElement.lang = 'fr'; document.body.style.backgroundColor = value.c.bg; document.documentElement.style.colorScheme = dk ? 'dark' : 'light'; }
  }, [value.c, dk]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Couleur associée à un statut de visite. */
export function visitStatusColor(c: Palette, status: string): string {
  return ({ planned: c.stPlanned, organized: c.stOrganized, in_progress: c.stProgress, done: c.stDone, validated: c.stValidated, cancelled: c.stCancelled, deleted: c.stCancelled, closed: c.ok } as Record<string, string>)[status] ?? c.muted;
}
