// Synthèse par IA : un compte rendu structuré à partir de notes brutes. Le fournisseur est interchangeable (voir docs/IA_MISTRAL.md).

export interface StructureInput {
  sourceText: string;
  language: string;                      // langue du compte rendu : fr, en, es, it, de, nl
  today: string;                         // AAAA-MM-JJ, pour résoudre « jeudi prochain »
  glossary: string[];                    // termes à respecter (produits, acronymes)
}

export interface ProposedAction { title: string; due_date: string | null; due_date_certain: boolean }

export interface Proposal {
  fields: { summary: string; needs: string; objections: string; competitors: string; decisions: string; next_step: string };
  actions: ProposedAction[];
}

export interface Usage { tokensIn: number | null; tokensOut: number | null }

export interface StructureResult {
  proposal: Proposal;
  warnings: string[];                    // contrôles automatiques : nombre ou nom absent du texte source, échéance passée…
  provider: string;
  model: string;
  usage: Usage;
  costCents: number;
}

/**
 * Journal des échecs du fournisseur (statut HTTP et début du message d'erreur), pour diagnostiquer un refus de format ou de modèle.
 * Jamais la clé, jamais le texte des notes ni l'audio : seulement ce que le fournisseur répond.
 */
export type AiLog = (event: string, details: Record<string, unknown>) => void;
export const defaultAiLog: AiLog = (event, d) => console.error(`[ia] ${event}`, JSON.stringify(d));

/** Début du corps d'une réponse d'erreur du fournisseur, borné et sans retour à la ligne. */
export async function errorSnippet(res: Response, max = 300): Promise<string> {
  try { return (await res.text()).replace(/\s+/g, ' ').slice(0, max); } catch { return ''; }
}

/** Erreurs de l'IA : le message est neutre (jamais de contenu des notes). */
export class AiError extends Error { constructor(public kind: 'unavailable' | 'upstream' | 'invalid_output', message: string) { super(message); } }

// --- Brief avant visite ---

export interface BriefReport { date: string | null; temperature: string | null; summary: string; needs: string; objections: string; competitors: string; decisions: string; next_step: string }
export interface BriefInput {
  language: string; today: string;
  objective: string | null; preparationNotes: string | null; plannedStart: string | null;
  reports: BriefReport[];                                          // comptes rendus validés des visites précédentes, du plus récent au plus ancien
  openActions: { title: string; due_date: string | null; late: boolean }[];
  glossary: string[];
}
export interface Brief { summary: string; where_we_left: string; to_address: string[]; watch_out: string[]; questions: string[] }
export interface BriefResult { brief: Brief; warnings: string[]; provider: string; model: string; usage: Usage; costCents: number }

// --- Contrôle du compte rendu avant validation ---

export type ReviewField = 'summary' | 'needs' | 'objections' | 'competitors' | 'decisions' | 'next_step' | 'actions' | 'general';
export interface ReviewIssue { field: ReviewField; severity: 'warning' | 'info'; message: string; source: 'rules' | 'ai' }
export interface ReviewInput {
  language: string; today: string;
  fields: { summary: string; needs: string; objections: string; competitors: string; decisions: string; next_step: string };
  temperature: string | null;
  actions: { title: string; due_date: string | null }[];
  noAction: boolean;
  notes: string;                                                    // notes prises pendant la visite (jamais les notes internes ni privées)
}
export interface ReviewResult { issues: ReviewIssue[]; provider: string; model: string; usage: Usage; costCents: number }

export interface AiService {
  readonly provider: string;
  structure(input: StructureInput): Promise<StructureResult>;
  brief(input: BriefInput): Promise<BriefResult>;
  review(input: ReviewInput): Promise<ReviewResult>;
}

// --- Transcription vocale (voix vers texte) ---

export interface TranscribeInput {
  audio: Buffer;
  mime: string;                          // audio/webm, audio/mp4, audio/mpeg, audio/wav…
  language?: string;                     // code ISO 639-1 ; absent : détection automatique par le modèle
}

export interface TranscribeResult {
  text: string;
  language: string | null;               // langue détectée ou demandée
  provider: string;
  model: string;
  audioSeconds: number | null;           // si le fournisseur l'indique
}

export interface TranscriptionService {
  readonly provider: string;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}
