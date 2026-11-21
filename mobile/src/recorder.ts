import { Audio } from 'expo-av';

export interface RecordedAudio { body: Blob; mime: string; durationS?: number }
export class RecorderError extends Error { constructor(public kind: 'permission' | 'unavailable' | 'failed', m?: string) { super(m ?? kind); } }
export interface Recorder { available: boolean; start(): Promise<void>; stop(): Promise<RecordedAudio>; cancel(): Promise<void> }

/**
 * Enregistrement natif (iOS, Android) avec expo-av : fichier m4a (AAC).
 * NON TESTÉ SUR APPAREIL : compile seulement. L'enregistrement en arrière-plan et après interruption reste à vérifier.
 */
export function createRecorder(): Recorder {
  let rec: Audio.Recording | undefined;
  let startedAt = 0;
  return {
    available: true,
    async start() {
      const p = await Audio.requestPermissionsAsync();
      if (!p.granted) throw new RecorderError('permission');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      rec = recording; startedAt = Date.now();
    },
    async stop() {
      if (!rec) throw new RecorderError('failed', 'Aucun enregistrement en cours');
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI(); rec = undefined;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      if (!uri) throw new RecorderError('failed');
      return { body: await (await fetch(uri)).blob(), mime: 'audio/mp4', durationS: (Date.now() - startedAt) / 1000 };
    },
    async cancel() { try { await rec?.stopAndUnloadAsync(); } catch { /* déjà arrêté */ } rec = undefined; },
  };
}
