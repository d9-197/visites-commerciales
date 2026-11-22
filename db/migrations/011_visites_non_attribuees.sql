-- 011 : une visite en préparation peut ne pas être attribuée (auteur absent) ; elle est ensuite affectée à un commercial ou à un directeur.
--       Les visites non attribuées ne se démarrent pas : seules « à organiser », « organisée », « annulée » et « supprimée » sont permises sans auteur.
--       Historique : événement « author » (affectation). Idempotent.
ALTER TABLE visit ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE visit DROP CONSTRAINT IF EXISTS visit_author_required;
ALTER TABLE visit ADD CONSTRAINT visit_author_required CHECK (author_id IS NOT NULL OR status IN ('planned','organized','cancelled','deleted'));
ALTER TABLE visit_history DROP CONSTRAINT IF EXISTS visit_history_field_check;
ALTER TABLE visit_history ADD CONSTRAINT visit_history_field_check CHECK (field IN ('planned_start','location_text','report_validated','report_reopened','visit_deleted','org_node','author'));
CREATE OR REPLACE VIEW crm_visit AS
  SELECT v.id, v.company_id, c.crm_id AS company_crm_id, v.author_id, u.email AS author_email,
         v.visit_type, v.objective, v.planned_start, v.planned_end, v.started_at, v.ended_at,
         v.location_text, v.status, v.created_at, v.updated_at, v.seq, v.deleted_at
  FROM visit v JOIN company c ON c.id = v.company_id LEFT JOIN app_user u ON u.id = v.author_id;
