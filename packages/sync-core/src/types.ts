// Types et règles partagés entre le back et l'application (voir docs/API.md §3).

export type EntityName = 'visit' | 'visit_contact' | 'report' | 'note' | 'internal_note' | 'private_note' | 'action'
  | 'recording' | 'attachment' | 'glossary_term';

export type OpKind = 'create' | 'update' | 'delete';

export interface Operation {
  id: string;
  entity: EntityName;
  entity_id: string;
  op: OpKind;
  base_version?: number;
  payload: Record<string, unknown>;
}

export type OperationResultStatus = 'applied' | 'conflict' | 'rejected';

export interface ConflictField {
  field: string;
  server_value: unknown;
  resolution: 'server_wins' | 'both_kept';
}

export interface OperationResult {
  id: string;
  result: OperationResultStatus;
  version?: number;
  code?: string;
  message?: string;
  conflict?: { server_version: number; fields: ConflictField[] };
}

export interface PullResponse {
  next_cursor: string;
  has_more: boolean;
  server_time: string;
  changes: Partial<Record<ChangeKey, Row[]>>;
  revocations: { entity: string; entity_id: string }[];
}

export type Row = Record<string, any>;

export type ChangeKey = 'companies' | 'contacts' | 'assignments' | 'colleagues' | 'visits' | 'visit_contacts'
  | 'reports' | 'notes' | 'internal_notes' | 'private_notes' | 'attachments' | 'actions' | 'recordings' | 'ai_proposals' | 'glossary_terms' | 'visit_history';

/** Entité de l'API -> clé du tableau renvoyé par pull. */
export const CHANGE_KEY: Partial<Record<EntityName, ChangeKey>> = {
  visit: 'visits', visit_contact: 'visit_contacts', report: 'reports', note: 'notes', internal_note: 'internal_notes',
  private_note: 'private_notes', action: 'actions',
};

/** Entités qui portent un numéro de version (contrôle de modification concurrente). */
export const VERSIONED: ReadonlySet<EntityName> = new Set(['visit', 'report', 'private_note', 'action']);

/** Textes longs : en cas de modification concurrente, on garde les deux versions. */
export const LONG_TEXT_FIELDS: Partial<Record<EntityName, readonly string[]>> = {
  visit: ['objective', 'preparation_notes'],
  report: ['summary', 'needs', 'objections', 'competitors', 'decisions', 'next_step'],
  private_note: ['body'],
};

export function versionLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d < 0; }
  return false;
}
