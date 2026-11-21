import React, { useState } from 'react';
import { Linking, Platform, Pressable, Text } from 'react-native';
import { Sheet } from './Sheet';
import { useTheme } from './theme';
import { detectEnv, navigationOptions } from './nav';

/** Ouvre une adresse web ou un lien d'application. Sur le web, les liens geo: doivent naviguer dans l'onglet courant. */
async function openUrl(url: string) {
  if (Platform.OS === 'web' && !/^https?:/i.test(url)) { window.location.assign(url); return; }
  await Linking.openURL(url);
}

/**
 * Fenêtre « Ouvrir l'itinéraire avec… » : l'utilisateur choisit l'application à chaque fois qu'il touche l'adresse.
 * NON TESTÉ SUR APPAREIL pour l'ouverture réelle des applications ; la liste proposée par plateforme est testée.
 */
export function NavChooser({ address, visible, onClose }: { address: string; visible: boolean; onClose: () => void }) {
  const { s, c } = useTheme();
  const [err, setErr] = useState<string>();
  const ua = Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const options = navigationOptions(address, detectEnv(Platform.OS, ua));
  return (
    <Sheet title="Ouvrir l'itinéraire avec…" visible={visible} onClose={onClose}>
      <Text style={s.muted}>{address}</Text>
      {options.map(o => (
        <Pressable key={o.id} accessibilityRole="button" style={s.choice}
          onPress={() => { setErr(undefined); openUrl(o.url).then(onClose).catch(() => setErr(`Impossible d'ouvrir ${o.label}. Essayez une autre application.`)); }}>
          <Text style={{ color: c.text, fontSize: 16 }}>{o.label}</Text>
        </Pressable>
      ))}
      {err ? <Text style={s.err}>{err}</Text> : null}
      <Pressable onPress={onClose} accessibilityRole="button" style={[s.choice, { alignItems: 'center' }]}><Text style={{ color: c.muted }}>Annuler</Text></Pressable>
    </Sheet>
  );
}
