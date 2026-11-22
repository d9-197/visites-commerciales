-- 009 : organisation arborescente. Les nœuds forment un arbre ; un utilisateur est affecté à un ou plusieurs nœuds (même rôle partout).
-- Un manager ou directeur voit les données de la branche de ses nœuds (nœud et descendants), consolidées ; un commercial, les siennes
-- (et celles de ses collègues sur ses clients en mode 1, dans ses branches). Une visite appartient à un nœud (celui de son auteur, choisi
-- à la création quand l'auteur est dans plusieurs nœuds). Le « supérieur » (manager_id) est remplacé par l'arborescence : la colonne
-- reste en base pour la conversion, plus aucune règle ne s'en sert. Idempotent.

CREATE TABLE IF NOT EXISTS org_node (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  uuid REFERENCES org_node(id),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS org_closure (
  ancestor_id   uuid NOT NULL REFERENCES org_node(id) ON DELETE CASCADE,
  descendant_id uuid NOT NULL REFERENCES org_node(id) ON DELETE CASCADE,
  depth         int  NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX IF NOT EXISTS org_closure_desc_idx ON org_closure(descendant_id);
CREATE TABLE IF NOT EXISTS user_org (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES org_node(id),
  PRIMARY KEY (user_id, node_id)
);
CREATE INDEX IF NOT EXISTS user_org_node_idx ON user_org(node_id);

-- « Supervise » : un manager ou directeur supervise les utilisateurs affectés à un nœud de sa branche (lui-même inclus, profondeur 0).
CREATE OR REPLACE FUNCTION rebuild_hierarchy() RETURNS void LANGUAGE sql AS $$
  DELETE FROM user_hierarchy;
  INSERT INTO user_hierarchy(ancestor_id, descendant_id, depth)
  SELECT ancestor_id, descendant_id, min(depth) FROM (
    SELECT id AS ancestor_id, id AS descendant_id, 0 AS depth FROM app_user
    UNION ALL
    SELECT vo.user_id, uu.user_id, c.depth + 1
    FROM user_org vo
    JOIN app_user v ON v.id = vo.user_id AND v.role IN ('manager', 'directeur')
    JOIN org_closure c ON c.ancestor_id = vo.node_id
    JOIN user_org uu ON uu.node_id = c.descendant_id
    WHERE uu.user_id <> vo.user_id
  ) x GROUP BY ancestor_id, descendant_id;
$$;

-- Reconstruit la fermeture de l'arbre, puis la hiérarchie des utilisateurs. À appeler après toute modification de l'arbre ou des affectations.
CREATE OR REPLACE FUNCTION rebuild_org() RETURNS void LANGUAGE sql AS $$
  DELETE FROM org_closure;
  WITH RECURSIVE t(ancestor_id, descendant_id, depth) AS (
    SELECT id, id, 0 FROM org_node
    UNION ALL
    SELECT p.parent_id, t.descendant_id, t.depth + 1 FROM t JOIN org_node p ON p.id = t.ancestor_id WHERE p.parent_id IS NOT NULL AND t.depth < 30
  )
  INSERT INTO org_closure(ancestor_id, descendant_id, depth)
  SELECT DISTINCT ON (ancestor_id, descendant_id) ancestor_id, descendant_id, depth FROM t ORDER BY ancestor_id, descendant_id, depth;
  SELECT rebuild_hierarchy();
$$;

-- L'utilisateur a-t-il accès à ce nœud (l'un de ses nœuds, ou un nœud de sa branche) ?
CREATE OR REPLACE FUNCTION org_access(p_user uuid, p_node uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM user_org uo JOIN org_closure c ON c.ancestor_id = uo.node_id WHERE uo.user_id = p_user AND c.descendant_id = p_node)
$$;
-- Manager ou directeur ayant accès au nœud : voit tout ce qui s'y trouve, branches comprises.
CREATE OR REPLACE FUNCTION org_supervises(p_user uuid, p_node uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT org_access(p_user, p_node) AND EXISTS (SELECT 1 FROM app_user u WHERE u.id = p_user AND u.role IN ('manager', 'directeur'))
$$;

-- Chemin lisible d'un nœud : « Entreprise › Rhône › Agence Lyon ».
CREATE OR REPLACE FUNCTION org_path(p_node uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT string_agg(n.name, ' › ' ORDER BY c.depth DESC) FROM org_closure c JOIN org_node n ON n.id = c.ancestor_id WHERE c.descendant_id = p_node
$$;

-- Conversion de l'ancienne hiérarchie (manager_id) : un nœud « Équipe X » par utilisateur qui supervise quelqu'un ou qui n'a pas de supérieur ;
-- les autres utilisateurs rejoignent l'équipe de leur supérieur ; les équipes de premier niveau sont sous un nœud « Entreprise ».
-- Même visibilité qu'avant. Sans effet si l'arbre existe déjà.
CREATE OR REPLACE FUNCTION convert_managers_to_org() RETURNS void LANGUAGE plpgsql AS $$
DECLARE root uuid; r record; nid uuid; parent uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM org_node) THEN RETURN; END IF;
  INSERT INTO org_node(name) VALUES ('Entreprise') RETURNING id INTO root;
  CREATE TEMP TABLE _team(user_id uuid PRIMARY KEY, node_id uuid) ON COMMIT DROP;
  FOR r IN
    WITH RECURSIVE t(id, manager_id, depth) AS (
      SELECT id, manager_id, 0 FROM app_user WHERE manager_id IS NULL
      UNION ALL
      SELECT u.id, u.manager_id, t.depth + 1 FROM app_user u JOIN t ON u.manager_id = t.id WHERE t.depth < 20)
    SELECT t.id, t.manager_id, a.display_name, EXISTS (SELECT 1 FROM app_user s WHERE s.manager_id = t.id) AS lead
    FROM t JOIN app_user a ON a.id = t.id ORDER BY t.depth, a.display_name
  LOOP
    IF r.manager_id IS NULL OR r.lead THEN
      parent := CASE WHEN r.manager_id IS NULL THEN root ELSE (SELECT node_id FROM _team WHERE user_id = r.manager_id) END;
      INSERT INTO org_node(parent_id, name) VALUES (parent, 'Équipe ' || r.display_name) RETURNING id INTO nid;
      INSERT INTO _team VALUES (r.id, nid);
      INSERT INTO user_org VALUES (r.id, nid);
    ELSE
      INSERT INTO user_org VALUES (r.id, (SELECT node_id FROM _team WHERE user_id = r.manager_id));
    END IF;
  END LOOP;
  PERFORM rebuild_org();
END $$;

SELECT convert_managers_to_org();

-- Une visite appartient à un nœud (celui de son auteur ; l'« Entreprise » à défaut).
ALTER TABLE visit ADD COLUMN IF NOT EXISTS org_node_id uuid REFERENCES org_node(id);
UPDATE visit v SET org_node_id = COALESCE(
  (SELECT uo.node_id FROM user_org uo WHERE uo.user_id = v.author_id ORDER BY uo.node_id LIMIT 1),
  (SELECT id FROM org_node WHERE parent_id IS NULL ORDER BY created_at LIMIT 1)) WHERE org_node_id IS NULL;
ALTER TABLE visit ALTER COLUMN org_node_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS visit_org_idx ON visit(org_node_id);

CREATE OR REPLACE FUNCTION can_read_visit(p_user uuid, p_visit uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM visit v
    WHERE v.id = p_visit AND (
      v.author_id = p_user
      OR org_supervises(p_user, v.org_node_id)
      OR (visibility_mode() = 1 AND org_access(p_user, v.org_node_id) AND EXISTS (
            SELECT 1 FROM company_assignment a WHERE a.company_id = v.company_id AND a.user_id = p_user AND a.removed_at IS NULL))
    )
  )
$$;

CREATE OR REPLACE FUNCTION can_read_action(p_user uuid, p_action uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM action_item x
    WHERE x.id = p_action AND (
      x.author_id = p_user OR x.owner_id = p_user
      OR (x.visit_id IS NOT NULL AND EXISTS (SELECT 1 FROM visit v WHERE v.id = x.visit_id AND org_supervises(p_user, v.org_node_id)))
      OR (x.visit_id IS NULL AND EXISTS (SELECT 1 FROM user_hierarchy h WHERE h.ancestor_id = p_user AND h.descendant_id = x.owner_id)))
  )
$$;

CREATE OR REPLACE FUNCTION can_read_internal_note(p_user uuid, p_note uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM internal_note n JOIN visit v ON v.id = n.visit_id
    WHERE n.id = p_note AND (n.author_id = p_user OR org_supervises(p_user, v.org_node_id))
  )
$$;
