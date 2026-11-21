-- 003 : notes internes d'une visite. Partagées avec la hiérarchie de leur auteur ; n'apparaissent pas dans le compte rendu,
-- ne sont envoyées ni à l'IA ni au CRM (aucune vue CRM ne les expose). Idempotent.
CREATE TABLE IF NOT EXISTS internal_note (
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
DROP TRIGGER IF EXISTS internal_note_seq ON internal_note;
CREATE TRIGGER internal_note_seq BEFORE INSERT OR UPDATE ON internal_note FOR EACH ROW EXECUTE FUNCTION bump_seq();
CREATE INDEX IF NOT EXISTS internal_note_visit_idx ON internal_note(visit_id);
CREATE INDEX IF NOT EXISTS internal_note_seq_idx ON internal_note(seq);

-- Lisible par l'auteur et par sa hiérarchie (la fermeture contient l'utilisateur lui-même), indépendamment du mode de visibilité des comptes rendus.
CREATE OR REPLACE FUNCTION can_read_internal_note(p_user uuid, p_note uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM internal_note n
    JOIN user_hierarchy h ON h.descendant_id = n.author_id
    WHERE n.id = p_note AND h.ancestor_id = p_user
  )
$$;
