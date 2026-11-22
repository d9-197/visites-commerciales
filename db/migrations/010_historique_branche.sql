-- 010 : l'historique d'une visite enregistre aussi le changement de branche (réaffectation par un administrateur). Idempotent.
ALTER TABLE visit_history DROP CONSTRAINT IF EXISTS visit_history_field_check;
ALTER TABLE visit_history ADD CONSTRAINT visit_history_field_check CHECK (field IN ('planned_start','location_text','report_validated','report_reopened','visit_deleted','org_node'));
