-- Schéma de données v0.1 — PostgreSQL 16
-- Voir docs/SCHEMA_DONNEES.md pour les règles et les décisions.
-- Brouillon : non éprouvé en charge, à valider par le prototype de synchro.

CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================
-- 1. Mécanisme de synchronisation : compteur global de changements
-- ============================================================
CREATE SEQUENCE change_seq;

-- À chaque insertion ou modification, la ligne reçoit un nouveau numéro de changement.
-- Les appareils demandent « tout ce qui a un seq supérieur à N ».
CREATE FUNCTION bump_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.seq := nextval('change_seq');
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ============================================================
-- 2. Référentiels
-- ============================================================
CREATE TABLE language (
  code    text PRIMARY KEY,               -- 'fr','en','es','it','de','nl'
  label   text NOT NULL,
  enabled boolean NOT NULL DEFAULT false  -- ouverture langue par langue (voir PHASE0_PLAN)
);
INSERT INTO language(code,label,enabled) VALUES
 ('fr','Français',true),('en','English',false),('es','Español',false),
 ('it','Italiano',false),('de','Deutsch',false),('nl','Nederlands',false);

CREATE TABLE visit_type (
  code   text PRIMARY KEY,
  labels jsonb NOT NULL,                  -- {"fr":"Suivi","en":"Follow-up",...}
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE app_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Réglages initiaux. report_visibility_mode : 1 = commerciaux du client + hiérarchie ; 2 = auteur + hiérarchie.
INSERT INTO app_setting(key,value) VALUES
 ('report_visibility_mode','2'),
 ('audio_retention_days','30'),
 ('offline_window_days','7'),
 ('ai_monthly_budget_cents','3000');

-- ============================================================
-- 3. Utilisateurs, hiérarchie, appareils
-- ============================================================
CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  display_name   text NOT NULL,
  role           text NOT NULL CHECK (role IN ('commercial','manager','directeur')),
  is_admin       boolean NOT NULL DEFAULT false,   -- rôle IT, cumulable avec le rôle métier
  manager_id     uuid REFERENCES app_user(id),     -- supérieur direct
  ui_language    text NOT NULL DEFAULT 'fr' REFERENCES language(code),
  dictation_language text NOT NULL DEFAULT 'fr' REFERENCES language(code), -- une langue par commercial
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  password_hash  text NOT NULL,                    -- argon2id
  mfa_secret_enc bytea,                            -- secret TOTP chiffré
  mfa_enabled    boolean NOT NULL DEFAULT false,
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  ai_budget_cents int,                             -- surcharge du plafond mensuel, NULL = réglage global
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  seq            bigint NOT NULL DEFAULT 0,
  CHECK (manager_id IS NULL OR manager_id <> id)
);
CREATE TRIGGER app_user_seq BEFORE INSERT OR UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX app_user_manager_idx ON app_user(manager_id);

-- Fermeture transitive de la hiérarchie : (ancêtre, descendant, profondeur).
-- profondeur 0 = l'utilisateur lui-même. Reconstruite par rebuild_hierarchy().
CREATE TABLE user_hierarchy (
  ancestor_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  descendant_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  depth         int  NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX user_hierarchy_desc_idx ON user_hierarchy(descendant_id);

CREATE FUNCTION rebuild_hierarchy() RETURNS void LANGUAGE sql AS $$
  DELETE FROM user_hierarchy;
  WITH RECURSIVE t(ancestor_id, descendant_id, depth) AS (
    SELECT id, id, 0 FROM app_user
    UNION ALL
    SELECT u.manager_id, t.descendant_id, t.depth + 1
    FROM t JOIN app_user u ON u.id = t.ancestor_id
    WHERE u.manager_id IS NOT NULL AND t.depth < 10   -- garde-fou contre un cycle
  )
  INSERT INTO user_hierarchy SELECT DISTINCT ON (ancestor_id, descendant_id) ancestor_id, descendant_id, depth
  FROM t ORDER BY ancestor_id, descendant_id, depth;
$$;

CREATE TABLE device (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id),
  platform     text NOT NULL CHECK (platform IN ('ios','android','web')),
  os_version   text,
  app_version  text,
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX device_user_idx ON device(user_id);

CREATE TABLE refresh_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  device_id   uuid NOT NULL REFERENCES device(id),
  token_hash  text NOT NULL UNIQUE,                -- jamais le jeton en clair
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 4. Données venant du CRM (lecture seule dans l'application)
-- ============================================================
CREATE TABLE company (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_id        text NOT NULL UNIQUE,              -- identifiant dans le CRM
  name          text NOT NULL,
  address_line  text,
  postal_code   text,
  city          text,
  country       text,
  sector        text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  inactive_since timestamptz,
  merged_into   uuid REFERENCES company(id),       -- renseigné par l'admin tant que le CRM ne fournit pas l'absorbant
  crm_synced_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT 0,
  deleted_at    timestamptz
);
CREATE TRIGGER company_seq BEFORE INSERT OR UPDATE ON company FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX company_seq_idx ON company(seq);
CREATE INDEX company_name_idx ON company(lower(name));

CREATE TABLE contact (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_id      text NOT NULL UNIQUE,
  company_id  uuid NOT NULL REFERENCES company(id),
  full_name   text NOT NULL,
  job_title   text,
  phone       text,
  email       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  seq         bigint NOT NULL DEFAULT 0,
  deleted_at  timestamptz
);
CREATE TRIGGER contact_seq BEFORE INSERT OR UPDATE ON contact FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX contact_company_idx ON contact(company_id);
CREATE INDEX contact_seq_idx ON contact(seq);

-- Commerciaux affectés à un client. Alimenté par le CRM (source 'crm') ; l'admin peut corriger (source 'admin').
CREATE TABLE company_assignment (
  company_id uuid NOT NULL REFERENCES company(id),
  user_id    uuid NOT NULL REFERENCES app_user(id),
  source     text NOT NULL DEFAULT 'crm' CHECK (source IN ('crm','admin')),
  since      timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,                          -- retrait logique (visible de la synchro)
  updated_at timestamptz NOT NULL DEFAULT now(),
  seq        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, user_id)
);
CREATE TRIGGER company_assignment_seq BEFORE INSERT OR UPDATE ON company_assignment FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX company_assignment_user_idx ON company_assignment(user_id) WHERE removed_at IS NULL;

-- ============================================================
-- 5. Visites et comptes rendus (source de vérité : le back)
-- ============================================================
-- Les identifiants sont générés sur l'appareil (UUID) pour créer hors-ligne.
CREATE TABLE visit (
  id            uuid PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES company(id),
  author_id     uuid NOT NULL REFERENCES app_user(id),
  visit_type    text REFERENCES visit_type(code),
  objective     text,
  planned_start timestamptz,
  planned_end   timestamptz,
  started_at    timestamptz,
  ended_at      timestamptz,
  location_text text,
  status        text NOT NULL DEFAULT 'planned' CONSTRAINT visit_status_check CHECK (status IN ('planned','organized','in_progress','done','validated','cancelled','deleted')),
  version       int  NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT 0,
  deleted_at    timestamptz,
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
CREATE TRIGGER visit_seq BEFORE INSERT OR UPDATE ON visit FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX visit_company_idx ON visit(company_id);
CREATE INDEX visit_author_planned_idx ON visit(author_id, planned_start);
CREATE INDEX visit_seq_idx ON visit(seq);

CREATE TABLE visit_contact (
  visit_id   uuid NOT NULL REFERENCES visit(id),
  contact_id uuid NOT NULL REFERENCES contact(id),
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  seq        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (visit_id, contact_id)
);
CREATE TRIGGER visit_contact_seq BEFORE INSERT OR UPDATE ON visit_contact FOR EACH ROW EXECUTE FUNCTION bump_seq();

-- Historique des modifications de date prévue et d'adresse (écrit par le back, jamais par l'appareil).
CREATE TABLE visit_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id        uuid NOT NULL REFERENCES visit(id),
  field           text NOT NULL CHECK (field IN ('planned_start','location_text','report_validated','report_reopened','visit_deleted')),
  old_value       text,
  new_value       text,
  changed_by      uuid REFERENCES app_user(id),
  changed_by_name text NOT NULL,                  -- copié au moment de la modification : l'historique ne dépend pas de la lecture de l'utilisateur
  changed_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  seq             bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER visit_history_seq BEFORE INSERT OR UPDATE ON visit_history FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX visit_history_visit_idx ON visit_history(visit_id);
CREATE INDEX visit_history_seq_idx ON visit_history(seq);


-- Compte rendu : champs structurés de la version finale (validée par le commercial).
CREATE TABLE visit_report (
  id             uuid PRIMARY KEY,
  visit_id       uuid NOT NULL UNIQUE REFERENCES visit(id),
  language       text NOT NULL REFERENCES language(code),
  summary        text,
  needs          text,
  objections     text,
  competitors    text,
  decisions      text,
  next_step      text,
  opportunity_temperature text CHECK (opportunity_temperature IN ('cold','warm','hot')),
  no_action      boolean NOT NULL DEFAULT false,    -- « aucune action à prévoir » : requis pour valider un compte rendu sans action
  sent_to_client_at timestamptz,                    -- compte rendu transmis au client : plus de remise en brouillon
  draft_actions  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(draft_actions) = 'array'),   -- actions prévues, créées à la validation
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated')),
  validated_at   timestamptz,
  validated_by   uuid REFERENCES app_user(id),
  version        int  NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  seq            bigint NOT NULL DEFAULT 0,
  CHECK (status <> 'validated' OR validated_at IS NOT NULL)
);
CREATE TRIGGER visit_report_seq BEFORE INSERT OR UPDATE ON visit_report FOR EACH ROW EXECUTE FUNCTION bump_seq();

-- Notes publiques de la visite (ajout seulement : pas de conflit d'édition).
CREATE TABLE visit_note (
  id           uuid PRIMARY KEY,
  visit_id     uuid NOT NULL REFERENCES visit(id),
  author_id    uuid NOT NULL REFERENCES app_user(id),
  kind         text NOT NULL CHECK (kind IN ('text','voice','photo')),
  body         text,                               -- texte, ou transcription validée d'une note vocale
  recording_id uuid,                               -- FK ajoutée plus bas
  attachment_id uuid,                              -- FK ajoutée plus bas
  noted_at     timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  seq          bigint NOT NULL DEFAULT 0,
  deleted_at   timestamptz
);
CREATE TRIGGER visit_note_seq BEFORE INSERT OR UPDATE ON visit_note FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX visit_note_visit_idx ON visit_note(visit_id);

-- Note privée : table SÉPARÉE, jamais lue par l'API du CRM ni par les règles de visibilité hiérarchiques.
-- Seul l'auteur y accède. La séparation physique évite qu'une jointure ou une vue l'expose par erreur.
CREATE TABLE private_note (
  id         uuid PRIMARY KEY,
  visit_id   uuid NOT NULL REFERENCES visit(id),
  author_id  uuid NOT NULL REFERENCES app_user(id),
  body       text NOT NULL,
  version    int  NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  seq        bigint NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  UNIQUE (visit_id, author_id)
);
CREATE TRIGGER private_note_seq BEFORE INSERT OR UPDATE ON private_note FOR EACH ROW EXECUTE FUNCTION bump_seq();

-- Note interne : partagée avec la hiérarchie de l'auteur, hors compte rendu, jamais envoyée à l'IA ni au CRM.
CREATE TABLE internal_note (
  id          uuid PRIMARY KEY,
  visit_id    uuid NOT NULL REFERENCES visit(id),
  author_id   uuid NOT NULL REFERENCES app_user(id),
  author_name text NOT NULL,                          -- copié à la création : affichable par la hiérarchie sans autre lecture
  body        text NOT NULL CHECK (length(btrim(body)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  seq         bigint NOT NULL DEFAULT 0,
  deleted_at  timestamptz
);
CREATE TRIGGER internal_note_seq BEFORE INSERT OR UPDATE ON internal_note FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX internal_note_visit_idx ON internal_note(visit_id);
CREATE INDEX internal_note_seq_idx ON internal_note(seq);

-- Lisible par l'auteur et par sa hiérarchie (la fermeture contient l'utilisateur lui-même), indépendamment du mode de visibilité des comptes rendus.
CREATE OR REPLACE FUNCTION can_read_internal_note(p_user uuid, p_note uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM internal_note n
    JOIN user_hierarchy h ON h.descendant_id = n.author_id
    WHERE n.id = p_note AND h.ancestor_id = p_user
  )
$$;

CREATE TABLE attachment (
  id          uuid PRIMARY KEY,
  visit_id    uuid NOT NULL REFERENCES visit(id),
  uploader_id uuid NOT NULL REFERENCES app_user(id),
  storage_key text NOT NULL,
  mime_type   text NOT NULL,
  size_bytes  bigint NOT NULL,
  caption     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  seq         bigint NOT NULL DEFAULT 0,
  deleted_at  timestamptz
);
CREATE TRIGGER attachment_seq BEFORE INSERT OR UPDATE ON attachment FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX attachment_visit_idx ON attachment(visit_id);
ALTER TABLE visit_note ADD FOREIGN KEY (attachment_id) REFERENCES attachment(id);

-- ============================================================
-- 6. Voix et IA (jamais exposés au CRM : l'audio brut est exclu)
-- ============================================================
CREATE TABLE recording (
  id           uuid PRIMARY KEY,
  visit_id     uuid NOT NULL REFERENCES visit(id),
  user_id      uuid NOT NULL REFERENCES app_user(id),
  purpose      text NOT NULL CHECK (purpose IN ('report','note','action')),
  storage_key  text,                               -- NULL tant que l'envoi n'est pas terminé ou après purge
  mime_type    text,
  duration_s   numeric(8,1),
  size_bytes   bigint,
  language     text NOT NULL REFERENCES language(code),
  status       text NOT NULL DEFAULT 'pending_upload'
               CHECK (status IN ('pending_upload','uploaded','transcribing','transcribed','failed')),
  purge_after  timestamptz,
  purged_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  seq          bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER recording_seq BEFORE INSERT OR UPDATE ON recording FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX recording_purge_idx ON recording(purge_after) WHERE purged_at IS NULL;
ALTER TABLE visit_note ADD FOREIGN KEY (recording_id) REFERENCES recording(id);

CREATE TABLE transcription (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id   uuid NOT NULL REFERENCES recording(id),
  provider       text NOT NULL,                    -- adaptateur utilisé (interchangeable)
  model_version  text,
  language       text NOT NULL REFERENCES language(code),
  text           text,
  confidence     numeric(4,3),
  status         text NOT NULL CHECK (status IN ('ok','failed')),
  error          text,
  cost_cents     numeric(10,4),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcription_recording_idx ON transcription(recording_id);

-- Proposition de l'IA pour un compte rendu : conservée à côté de la version finale (audit et mesure de qualité).
CREATE TABLE ai_proposal (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id      uuid NOT NULL REFERENCES visit_report(id),
  transcription_id uuid REFERENCES transcription(id),
  provider       text NOT NULL,
  model_version  text,
  source_text    text NOT NULL,                    -- texte dicté fourni à l'IA
  proposal       jsonb NOT NULL,                   -- champs structurés + actions proposées, validé par schéma
  checks         jsonb,                            -- résultat du contrôle chiffres / noms
  cost_cents     numeric(10,4),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_proposal_report_idx ON ai_proposal(report_id);

-- Qualité mesurée à la validation (voir PHASE0_PLAN §3). Aucun contenu, seulement des mesures.
CREATE TABLE report_quality (
  report_id        uuid PRIMARY KEY REFERENCES visit_report(id),
  user_id          uuid NOT NULL REFERENCES app_user(id),
  language         text NOT NULL REFERENCES language(code),
  ai_proposal_id   uuid REFERENCES ai_proposal(id),
  accepted_unchanged boolean NOT NULL,
  edit_ratio       numeric(5,4),                   -- part du texte modifiée
  numbers_changed  int NOT NULL DEFAULT 0,
  names_changed    int NOT NULL DEFAULT 0,
  review_seconds   int,
  abandoned_to_manual boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE error_report (                         -- bouton « signaler une erreur »
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id  uuid REFERENCES visit_report(id),
  user_id    uuid NOT NULL REFERENCES app_user(id),
  category   text NOT NULL CHECK (category IN ('misheard','wrong_number','invented','missed_action','other')),
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_usage (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_user(id),
  kind        text NOT NULL CHECK (kind IN ('transcription','llm')),
  provider    text NOT NULL,
  model       text,
  audio_seconds numeric(10,1),
  tokens_in   int,
  tokens_out  int,
  cost_cents  numeric(10,4) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_user_month_idx ON ai_usage(user_id, created_at);

CREATE TABLE glossary_term (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      text NOT NULL CHECK (scope IN ('global','user')),
  user_id    uuid REFERENCES app_user(id),
  language   text NOT NULL REFERENCES language(code),
  term       text NOT NULL,
  variants   text[] NOT NULL DEFAULT '{}',          -- écritures ou prononciations proches
  category   text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  seq        bigint NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  CHECK ((scope = 'user') = (user_id IS NOT NULL))
);
CREATE TRIGGER glossary_term_seq BEFORE INSERT OR UPDATE ON glossary_term FOR EACH ROW EXECUTE FUNCTION bump_seq();

-- ============================================================
-- 7. Actions de suivi
-- ============================================================
CREATE TABLE action_item (
  id         uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES company(id),
  visit_id   uuid REFERENCES visit(id),
  author_id  uuid NOT NULL REFERENCES app_user(id),
  owner_id   uuid NOT NULL REFERENCES app_user(id),  -- = author_id dans le MVP ; distinct pour l'assignation après MVP
  title      text NOT NULL CHECK (length(btrim(title)) > 0),
  due_date   date,
  reminder   text NOT NULL DEFAULT 'none' CHECK (reminder IN ('none','same_day_9h','eve_17h')),
  status     text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done','cancelled')),
  origin     text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','dictated','ai')),
  completed_at timestamptz,
  version    int  NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  seq        bigint NOT NULL DEFAULT 0,
  deleted_at timestamptz,                           -- réservé : on annule (status) plutôt que supprimer
  CHECK (owner_id = author_id)                      -- MVP ; retirer cette contrainte pour l'assignation
);
CREATE TRIGGER action_item_seq BEFORE INSERT OR UPDATE ON action_item FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX action_owner_status_idx ON action_item(owner_id, status, due_date);
CREATE INDEX action_company_idx ON action_item(company_id);
CREATE INDEX action_seq_idx ON action_item(seq);

-- ============================================================
-- 8. Synchronisation : idempotence, retraits d'accès, conflits
-- ============================================================
-- Chaque opération envoyée par un appareil porte un identifiant unique ; la rejouer ne change rien.
CREATE TABLE client_operation (
  id          uuid PRIMARY KEY,                     -- fourni par l'appareil
  user_id     uuid NOT NULL REFERENCES app_user(id),
  device_id   uuid REFERENCES device(id),
  entity      text NOT NULL,
  entity_id   uuid NOT NULL,
  op          text NOT NULL CHECK (op IN ('create','update','delete')),
  payload     jsonb NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  result      text NOT NULL CHECK (result IN ('applied','conflict','rejected')),
  detail      jsonb
);
CREATE INDEX client_operation_user_idx ON client_operation(user_id, applied_at);

-- Une donnée cesse d'être visible pour un utilisateur (affectation retirée, changement de mode de visibilité,
-- changement de hiérarchie) : l'appareil doit la supprimer de sa base locale.
CREATE TABLE access_revocation (
  user_id    uuid NOT NULL REFERENCES app_user(id),
  entity     text NOT NULL,
  entity_id  uuid NOT NULL,
  seq        bigint NOT NULL DEFAULT nextval('change_seq'),
  PRIMARY KEY (user_id, entity, entity_id, seq)
);
CREATE INDEX access_revocation_user_seq_idx ON access_revocation(user_id, seq);

-- Deux versions d'un texte long modifiées en parallèle : on garde les deux et on alerte l'utilisateur.
CREATE TABLE text_conflict (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity         text NOT NULL,
  entity_id      uuid NOT NULL,
  field          text NOT NULL,
  user_id        uuid NOT NULL REFERENCES app_user(id),
  device_value   text,
  server_value   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);

-- ============================================================
-- 9. Intégration CRM
-- ============================================================
CREATE TABLE crm_sync_run (
  id           bigserial PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed')),
  cursor_after text,                                -- position de lecture incrémentale côté CRM
  companies_upserted int NOT NULL DEFAULT 0,
  contacts_upserted  int NOT NULL DEFAULT 0,
  assignments_changed int NOT NULL DEFAULT 0,
  companies_deactivated int NOT NULL DEFAULT 0,
  errors       jsonb
);

-- Comptes de service (clés d'API) : le CRM vient lire par l'API ; deux clés valides pendant un renouvellement.
CREATE TABLE service_account (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,                        -- ex. 'crm-lecture'
  key_prefix  text NOT NULL,                        -- début de la clé, pour l'identifier dans les journaux
  key_hash    text NOT NULL UNIQUE,                 -- jamais la clé en clair
  scopes      text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES app_user(id),
  actor_service_id uuid REFERENCES service_account(id),
  action      text NOT NULL,                        -- 'login','login_failed','user_disabled','setting_changed','crm_read',...
  entity      text,
  entity_id   text,
  detail      jsonb,                                -- jamais de contenu de compte rendu
  ip          inet
);
CREATE INDEX audit_log_at_idx ON audit_log(at);

-- ============================================================
-- 10. Règles de visibilité (appliquées par le back à chaque lecture)
-- ============================================================
CREATE FUNCTION visibility_mode() RETURNS int LANGUAGE sql STABLE AS
$$ SELECT COALESCE((SELECT (value #>> '{}')::int FROM app_setting WHERE key = 'report_visibility_mode'), 2) $$;

-- Un utilisateur voit-il cette visite (et son compte rendu) ?
--  mode 2 : l'auteur et sa hiérarchie.
--  mode 1 : mode 2, plus les commerciaux affectés au client et leur hiérarchie.
-- Les administrateurs IT ne voient PAS le contenu par ce seul rôle (décision à valider).
CREATE FUNCTION can_read_visit(p_user uuid, p_visit uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM visit v
    WHERE v.id = p_visit AND (
      EXISTS (SELECT 1 FROM user_hierarchy h WHERE h.ancestor_id = p_user AND h.descendant_id = v.author_id)
      OR (visibility_mode() = 1 AND EXISTS (
            SELECT 1 FROM company_assignment a
            JOIN user_hierarchy h ON h.descendant_id = a.user_id
            WHERE a.company_id = v.company_id AND a.removed_at IS NULL AND h.ancestor_id = p_user))
    )
  )
$$;

-- Clients visibles : affectés à l'utilisateur ou à quelqu'un de sa descendance.
CREATE FUNCTION can_read_company(p_user uuid, p_company uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_assignment a
    JOIN user_hierarchy h ON h.descendant_id = a.user_id
    WHERE a.company_id = p_company AND a.removed_at IS NULL AND h.ancestor_id = p_user
  )
$$;

-- Actions : le responsable et sa hiérarchie (lecture) ; l'auteur.
CREATE FUNCTION can_read_action(p_user uuid, p_action uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM action_item x
    WHERE x.id = p_action AND (
      x.author_id = p_user
      OR EXISTS (SELECT 1 FROM user_hierarchy h WHERE h.ancestor_id = p_user AND h.descendant_id = x.owner_id))
  )
$$;

-- ============================================================
-- 11. Vues pour l'API du CRM (compte de service : aucune règle de visibilité hiérarchique)
-- ============================================================
-- Exclus par construction : private_note, recording, transcription, ai_proposal.
-- Comptes rendus : seulement les versions validées (à valider avec l'équipe CRM).
CREATE VIEW crm_visit AS
  SELECT v.id, v.company_id, c.crm_id AS company_crm_id, v.author_id, u.email AS author_email,
         v.visit_type, v.objective, v.planned_start, v.planned_end, v.started_at, v.ended_at,
         v.location_text, v.status, v.created_at, v.updated_at, v.seq, v.deleted_at
  FROM visit v JOIN company c ON c.id = v.company_id JOIN app_user u ON u.id = v.author_id;

CREATE VIEW crm_report AS
  SELECT r.id, r.visit_id, r.language, r.summary, r.needs, r.objections, r.competitors, r.decisions,
         r.next_step, r.opportunity_temperature, r.validated_at, r.updated_at, r.seq
  FROM visit_report r WHERE r.status = 'validated';

CREATE VIEW crm_note AS
  SELECT n.id, n.visit_id, n.kind, n.body, n.noted_at, n.updated_at, n.seq, n.deleted_at
  FROM visit_note n;   -- suppressions logiques incluses (deleted_at) ; photos non exposées (attachment non repris)

CREATE VIEW crm_action AS
  SELECT x.id, x.company_id, c.crm_id AS company_crm_id, x.visit_id, x.title, x.due_date, x.status, x.origin,
         ow.email AS owner_email, x.completed_at, x.created_at, x.updated_at, x.seq, x.deleted_at
  FROM action_item x JOIN company c ON c.id = x.company_id JOIN app_user ow ON ow.id = x.owner_id;

CREATE VIEW crm_visit_history AS
  SELECT h.id, h.visit_id, h.field, h.old_value, h.new_value, h.changed_by_name, h.changed_at, h.updated_at, h.seq
  FROM visit_history h;
