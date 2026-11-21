import React, { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useTheme } from './theme';
import { fmtJsDate, roundTo15 } from './dates';

export interface DateFieldProps {
  label: string;
  value?: Date;
  onChange: (d?: Date) => void;
  mode: 'date' | 'datetime';
  clearable?: boolean;
}

/**
 * Sélecteur de date (et d'heure) natif : roue/cadran du système sur iOS, boîtes de dialogue du système sur Android.
 * NON TESTÉ SUR APPAREIL : le code compile mais n'a jamais été exécuté sur un téléphone. La version web (DateField.web.tsx)
 * est, elle, testée dans un navigateur.
 */
export function DateField({ label, value, onChange: onChangeRaw, mode, clearable }: DateFieldProps) {
  const { s, c } = useTheme();
  // Les heures se règlent par pas de 15 minutes : la valeur choisie est arrondie au quart d'heure le plus proche.
  const onChange = (d?: Date) => onChangeRaw(d && mode === 'datetime' ? roundTo15(d) : d);
  const [iosOpen, setIosOpen] = useState(false);

  const openAndroid = () => {
    const start = value ?? new Date();
    DateTimePickerAndroid.open({
      value: start, mode: 'date',
      onChange: (e, d) => {
        if (e.type !== 'set' || !d) return;
        if (mode === 'date') return onChange(d);
        DateTimePickerAndroid.open({
          value: d, mode: 'time', is24Hour: true,
          onChange: (e2, t) => { if (e2.type === 'set' && t) { const r = new Date(d); r.setHours(t.getHours(), t.getMinutes(), 0, 0); onChange(r); } },
        });
      },
    });
  };

  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button" accessibilityLabel={label}
        onPress={() => { if (Platform.OS === 'android') openAndroid(); else { if (!value) onChange(new Date()); setIosOpen(o => !o); } }}
        style={[s.input, { justifyContent: 'center' }]}>
        <Text style={{ color: value ? c.text : c.muted, fontSize: 16 }}>{value ? fmtJsDate(value, mode) : 'Choisir…'}</Text>
      </Pressable>
      {Platform.OS === 'ios' && iosOpen && value && (
        <DateTimePicker value={value} mode={mode} minuteInterval={15} display={mode === 'date' ? 'inline' : 'spinner'} locale="fr-FR" onChange={(_e, d) => { if (d) onChange(d); }} />
      )}
      {clearable && value && <Pressable onPress={() => { setIosOpen(false); onChange(undefined); }} accessibilityRole="button"><Text style={s.link}>Effacer</Text></Pressable>}
    </View>
  );
}
