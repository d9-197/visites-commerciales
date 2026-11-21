-- 007 : journal des envois d'e-mail d'une visite (qui, à qui, quelles parties, résultat). Le contenu n'est pas conservé. Idempotent.
CREATE TABLE IF NOT EXISTS visit_email (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id    uuid NOT NULL REFERENCES visit(id),
  sender_id   uuid NOT NULL REFERENCES app_user(id),
  recipients  text[] NOT NULL,
  parts       text[] NOT NULL,
  status      text NOT NULL CHECK (status IN ('sent','failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visit_email_sender_idx ON visit_email(sender_id, created_at);
CREATE INDEX IF NOT EXISTS visit_email_visit_idx ON visit_email(visit_id);
