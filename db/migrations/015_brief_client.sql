-- Brief IA d'un client (préparation d'une réunion depuis le back) : dernière version par client et par utilisateur.
CREATE TABLE ai_company_brief (
  company_id  uuid NOT NULL REFERENCES company(id),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  source_hash text NOT NULL,
  brief       jsonb NOT NULL,
  warnings    jsonb NOT NULL DEFAULT '[]',
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);
