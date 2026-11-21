import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, useColorScheme } from 'react-native';
import { loadTheme, saveTheme, type ThemePref } from './session';

export interface Palette {
  bg: string; surface: string; text: string; muted: string; line: string; accent: string; accentInk: string; accentSoft: string;
  okBg: string; warnBg: string; ok: string; err: string;
}
const light: Palette = { bg: '#F4F6F5', surface: '#FFFFFF', text: '#14212B', muted: '#5B6A74', line: '#D9DEDC', accent: '#0E6A87', accentInk: '#FFFFFF', accentSoft: '#DCEDF3', okBg: '#DDEFE4', warnBg: '#F7EACB', ok: '#2B7A4B', err: '#B3261E' };
const dark: Palette = { bg: '#0C1317', surface: '#152028', text: '#E7EDF0', muted: '#98A8B2', line: '#25333D', accent: '#4FB4D3', accentInk: '#06222C', accentSoft: '#12303B', okBg: '#173526', warnBg: '#3A2D10', ok: '#6CC58D', err: '#F2B8B5' };

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
    fact: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
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
