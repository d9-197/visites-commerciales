import React, { useEffect, useRef } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text } from 'react-native';
import { useTheme } from './theme';

/** Fenêtre qui monte du bas de l'écran (choix, édition d'un champ, historique). Se ferme en touchant en dehors. */
export function Sheet({ title, visible, onClose, children }: { title: string; visible: boolean; onClose: () => void; children: React.ReactNode }) {
  const { s } = useTheme();
  // Web : le bouton retour du téléphone ferme la fenêtre (une entrée d'historique est ajoutée à l'ouverture).
  // Android natif : Modal appelle déjà onRequestClose avec le bouton retour.
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    history.pushState({ ...(history.state ?? {}), sheet: true }, '');
    let closedByBack = false;
    const onPop = () => { closedByBack = true; closeRef.current(); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!closedByBack && history.state?.sheet) history.back();     // fermée par un bouton : on retire l'entrée d'historique
    };
  }, [visible]);
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={onClose} accessibilityLabel="Fermer">
        <Pressable onPress={() => {}} style={s.sheet} accessibilityViewIsModal>
          <Text style={s.h2} accessibilityRole="header">{title}</Text>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10 }}>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
