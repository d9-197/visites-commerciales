-- Objectif mensuel de visites par utilisateur (visiteur) : nombre de visites à réaliser dans le mois.
CREATE TABLE visit_target (
  user_id    uuid NOT NULL REFERENCES app_user(id),
  month      date NOT NULL CHECK (month = date_trunc('month', month)::date),
  target     integer NOT NULL CHECK (target >= 0 AND target <= 9999),
  set_by     uuid REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);
