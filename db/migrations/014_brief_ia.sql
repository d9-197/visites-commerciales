-- Brief avant visite généré par IA : dernière version conservée par visite et par utilisateur (évite de repayer un appel quand l'historique n'a pas changé).
CREATE TABLE ai_brief (
  visit_id    uuid NOT NULL REFERENCES visit(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id),
  source_hash text NOT NULL,
  brief       jsonb NOT NULL,
  warnings    jsonb NOT NULL DEFAULT '[]',
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visit_id, user_id)
);
