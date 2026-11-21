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

/** Erreurs de l'IA : le message est neutre (jamais de contenu des notes). */
export class AiError extends Error { constructor(public kind: 'unavailable' | 'upstream' | 'invalid_output', message: string) { super(message); } }

export interface AiService {
  readonly provider: string;
  structure(input: StructureInput): Promise<StructureResult>;
}
