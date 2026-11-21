-- 001 : statut « organized » (organisée avec le client) et historique des modifications de date et d'adresse d'une visite.
-- Idempotent : peut être rejoué sans erreur.
ALTER TABLE visit DROP CONSTRAINT IF EXISTS visit_status_check;
ALTER TABLE visit ADD CONSTRAINT visit_status_check CHECK (status IN ('planned','organized','in_progress','done','cancelled'));

CREATE TABLE IF NOT EXISTS visit_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id        uuid NOT NULL REFERENCES visit(id),
  field           text NOT NULL CHECK (field IN ('planned_start','location_text')),
  old_value       text,
  new_value       text,
  changed_by      uuid REFERENCES app_user(id),
  changed_by_name text NOT NULL,                  -- copié au moment de la modification : l'historique ne dépend pas de la lecture de l'utilisateur
  changed_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  seq             bigint NOT NULL DEFAULT 0
);
DROP TRIGGER IF EXISTS visit_history_seq ON visit_history;
CREATE TRIGGER visit_history_seq BEFORE INSERT OR UPDATE ON visit_history FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX IF NOT EXISTS visit_history_visit_idx ON visit_history(visit_id);
CREATE INDEX IF NOT EXISTS visit_history_seq_idx ON visit_history(seq);

CREATE OR REPLACE VIEW crm_visit_history AS
  SELECT h.id, h.visit_id, h.field, h.old_value, h.new_value, h.changed_by_name, h.changed_at, h.updated_at, h.seq
  FROM visit_history h;
