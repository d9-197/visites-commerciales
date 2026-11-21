import React, { useRef } from 'react';
import { Pressable, Text } from 'react-native';
import { useTheme } from './theme';
import type { RecordedAudio } from './recorder';

/**
 * Repli quand le micro du navigateur est indisponible (page en HTTP) : ouvre l'enregistreur du téléphone (Android) ou le
 * choix d'un fichier audio. Fonctionne en HTTP, contrairement à getUserMedia.
 */
export function AudioFilePicker({ disabled, compact, label, onFile }: { disabled?: boolean; compact?: boolean; label?: string; onFile: (a: RecordedAudio) => void }) {
  const { s } = useTheme();
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      {compact
        ? <Pressable disabled={disabled} accessibilityRole="button" accessibilityLabel={`Dicter : ${label ?? ''} (choisir un enregistrement audio)`} onPress={() => input.current?.click()} style={[s.iconBtn, disabled && s.btnOff]}>
            <Text style={s.iconText}>🎤</Text>
          </Pressable>
        : <Pressable disabled={disabled} accessibilityRole="button" onPress={() => input.current?.click()} style={[s.btn, s.btnSmall, disabled && s.btnOff]}>
            <Text style={s.btnText}>🎤 Choisir un enregistrement audio</Text>
          </Pressable>}
      {React.createElement('input', {
        ref: input, type: 'file', accept: 'audio/*', capture: 'user', 'aria-label': compact ? `Fichier audio : ${label ?? ''}` : 'Fichier audio', style: { display: 'none' },
        onChange: (e: { target: { files: FileList | null; value: string } }) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (f) onFile({ body: f, mime: f.type || 'audio/mp4' });
        },
      })}
    </>
  );
}
