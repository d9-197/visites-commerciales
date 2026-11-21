-- 006 : « aucune action à prévoir » (case à cocher avant validation), compte rendu transmis au client (verrou de la remise en brouillon),
--       événements dans l'historique de la visite (compte rendu validé, remis en brouillon, visite supprimée). Idempotent.
ALTER TABLE visit_report ADD COLUMN IF NOT EXISTS no_action boolean NOT NULL DEFAULT false;
ALTER TABLE visit_report ADD COLUMN IF NOT EXISTS sent_to_client_at timestamptz;
ALTER TABLE visit_history DROP CONSTRAINT IF EXISTS visit_history_field_check;
ALTER TABLE visit_history ADD CONSTRAINT visit_history_field_check CHECK (field IN ('planned_start','location_text','report_validated','report_reopened','visit_deleted'));
