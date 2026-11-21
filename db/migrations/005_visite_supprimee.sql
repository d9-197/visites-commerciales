-- 005 : statut « deleted » (visite supprimée) : conservée en base et synchronisée, masquée par défaut dans l'application. Idempotent.
ALTER TABLE visit DROP CONSTRAINT IF EXISTS visit_status_check;
ALTER TABLE visit ADD CONSTRAINT visit_status_check CHECK (status IN ('planned','organized','in_progress','done','validated','cancelled','deleted'));
