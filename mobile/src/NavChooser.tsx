import React, { useState } from 'react';
import { Linking, Modal, Platform, Pressable, Text, View } from 'react-native';
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
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={onClose} accessibilityLabel="Fermer">
        <Pressable onPress={() => {}} style={{ backgroundColor: c.surface, padding: 16, gap: 10, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
          <Text style={s.h2} accessibilityRole="header">Ouvrir l'itinéraire avec…</Text>
          <Text style={s.muted}>{address}</Text>
          {options.map(o => (
            <Pressable key={o.id} accessibilityRole="button" style={s.choice}
              onPress={() => { setErr(undefined); openUrl(o.url).then(onClose).catch(() => setErr(`Impossible d'ouvrir ${o.label}. Essayez une autre application.`)); }}>
              <Text style={{ color: c.text, fontSize: 16 }}>{o.label}</Text>
            </Pressable>
          ))}
          {err ? <Text style={s.err}>{err}</Text> : null}
          <Pressable onPress={onClose} accessibilityRole="button" style={[s.choice, { alignItems: 'center' }]}><Text style={{ color: c.muted }}>Annuler</Text></Pressable>
          <View style={{ height: 8 }} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
