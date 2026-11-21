export interface RecordedAudio { body: Blob; mime: string; durationS?: number }
export class RecorderError extends Error { constructor(public kind: 'permission' | 'unavailable' | 'failed', m?: string) { super(m ?? kind); } }
export interface Recorder { available: boolean; start(): Promise<void>; stop(): Promise<RecordedAudio>; cancel(): Promise<void> }

const MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

/**
 * Enregistrement dans le navigateur (MediaRecorder). Le micro n'est accessible qu'en contexte sécurisé : HTTPS, ou localhost.
 * En HTTP simple sur une adresse réseau (cas d'un essai sur le réseau local), `available` vaut false.
 */
export function createRecorder(): Recorder {
  const available = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  let mr: MediaRecorder | undefined; let stream: MediaStream | undefined; let chunks: Blob[] = []; let startedAt = 0;
  const release = () => { stream?.getTracks().forEach(t => t.stop()); stream = undefined; mr = undefined; };
  return {
    available,
    async start() {
      if (!available) throw new RecorderError('unavailable');
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (e: any) { throw new RecorderError(e?.name === 'NotAllowedError' ? 'permission' : 'failed'); }
      const mime = MIMES.find(m => MediaRecorder.isTypeSupported(m));
      chunks = []; mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      mr.start(); startedAt = Date.now();
    },
    stop() {
      return new Promise<RecordedAudio>((resolve, reject) => {
        if (!mr) return reject(new RecorderError('failed', 'Aucun enregistrement en cours'));
        const type = mr.mimeType || 'audio/webm';
        mr.onstop = () => { const durationS = (Date.now() - startedAt) / 1000; release(); resolve({ body: new Blob(chunks, { type }), mime: type, durationS }); };
        mr.stop();
      });
    },
    async cancel() { try { mr?.stop(); } catch { /* déjà arrêté */ } release(); },
  };
}
