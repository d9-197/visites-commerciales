/**
 * UUID v4 à partir de crypto.getRandomValues (disponible aussi sur une page servie en HTTP simple, contrairement à
 * crypto.randomUUID qui exige un contexte sécurisé). Repli sur Math.random seulement si aucun générateur n'existe :
 * acceptable pour des identifiants de ligne, pas pour un secret.
 */
export function uuidv4(): string {
  const b = new Uint8Array(16);
  const c: any = (globalThis as any).crypto;
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
