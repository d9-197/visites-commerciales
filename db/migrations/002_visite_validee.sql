-- 002 : statut « validated » (visite terminée dont le compte rendu est validé). Idempotent.
ALTER TABLE visit DROP CONSTRAINT IF EXISTS visit_status_check;
ALTER TABLE visit ADD CONSTRAINT visit_status_check CHECK (status IN ('planned','organized','in_progress','done','validated','cancelled'));

-- Visites déjà terminées dont le compte rendu est déjà validé : on les passe à « validée » (la version change, les appareils la reçoivent).
UPDATE visit v SET status = 'validated', version = version + 1
WHERE v.status = 'done' AND EXISTS (SELECT 1 FROM visit_report r WHERE r.visit_id = v.id AND r.status = 'validated');
