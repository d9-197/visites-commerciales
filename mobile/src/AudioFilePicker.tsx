import type { RecordedAudio } from './recorder';

/** Natif : le micro de l'application suffit, pas de sélecteur de fichier. */
export function AudioFilePicker(_props: { disabled?: boolean; onFile: (a: RecordedAudio) => void }) { return null; }
