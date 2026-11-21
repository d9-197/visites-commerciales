-- 004 : actions prévues dans le compte rendu (brouillon). Elles ne deviennent de vraies actions qu'à la validation du compte rendu
-- (création par le serveur, dans la même transaction). Idempotent.
ALTER TABLE visit_report ADD COLUMN IF NOT EXISTS draft_actions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE visit_report DROP CONSTRAINT IF EXISTS visit_report_draft_actions_check;
ALTER TABLE visit_report ADD CONSTRAINT visit_report_draft_actions_check CHECK (jsonb_typeof(draft_actions) = 'array');
