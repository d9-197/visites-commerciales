-- Un client dont l'utilisateur voit une visite lui est lisible (nom, adresse, contacts), même s'il ne lui est pas affecté.
CREATE OR REPLACE FUNCTION can_read_company(p_user uuid, p_company uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_assignment a
    JOIN user_hierarchy h ON h.descendant_id = a.user_id
    WHERE a.company_id = p_company AND a.removed_at IS NULL AND h.ancestor_id = p_user
  ) OR EXISTS (
    -- Un client dont on voit une visite (préparée par un manager, client réaffecté depuis...) reste lisible : sinon l'appli affiche une visite sans nom de client.
    SELECT 1 FROM visit v WHERE v.company_id = p_company AND v.deleted_at IS NULL AND can_read_visit(p_user, v.id)
  )
$$;
