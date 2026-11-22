-- 008 : application back (PC) : préparation des visites. « preparation_notes » : points à aborder, saisis avant la visite ;
--       « created_by » : personne qui a planifié la visite pour le commercial (manager, directeur, administrateur). Idempotent.
ALTER TABLE visit ADD COLUMN IF NOT EXISTS preparation_notes text;
ALTER TABLE visit ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES app_user(id);
