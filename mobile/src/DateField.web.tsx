import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from './theme';
import { dateToStr, roundTo15, strToDate, toLocalInputs } from './dates';
import type { DateFieldProps } from './DateField';

/** Version navigateur : champs natifs du navigateur (le téléphone affiche son sélecteur de date et d'heure). */
export function DateField({ label, value, onChange, mode, clearable }: DateFieldProps) {
  const { c, s } = useTheme();
  const str = !value ? '' : mode === 'date' ? dateToStr(value) : (() => { const i = toLocalInputs(value.toISOString()); return `${i.date}T${i.time}`; })();
  const parse = (v: string): Date | undefined => {
    if (!v) return undefined;
    const d = mode === 'date' ? strToDate(v) : new Date(v);
    return d && !Number.isNaN(d.getTime()) ? (mode === 'datetime' ? roundTo15(d) : d) : undefined;   // pas de 15 minutes
  };
  return (
    <View style={{ gap: 6 }}>
      {React.createElement('input', {
        type: mode === 'date' ? 'date' : 'datetime-local',
        step: mode === 'date' ? undefined : 900,   // 15 minutes
        value: str,
        'aria-label': label,
        onChange: (e: { target: { value: string } }) => onChange(parse(e.target.value)),
        style: {
          boxSizing: 'border-box', width: '100%', minWidth: 0, minHeight: 48, padding: 12, fontSize: 16, fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          color: c.text, backgroundColor: c.surface, border: `1px solid ${c.line}`, borderRadius: 12,
        },
      })}
      {clearable && value && <Pressable onPress={() => onChange(undefined)} accessibilityRole="button"><Text style={s.link}>Effacer</Text></Pressable>}
    </View>
  );
}
