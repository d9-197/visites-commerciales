\set ON_ERROR_STOP on
BEGIN;
-- hiérarchie : dir > mgr > (c1, c2) ; c3 dans une autre équipe : mgr2
INSERT INTO app_user(id,email,display_name,role,password_hash,manager_id) VALUES
 ('00000000-0000-0000-0000-0000000000d1','dir@x.fr','Dir','directeur','h',NULL),
 ('00000000-0000-0000-0000-0000000000a1','mgr@x.fr','Mgr','manager','h','00000000-0000-0000-0000-0000000000d1'),
 ('00000000-0000-0000-0000-0000000000a2','mgr2@x.fr','Mgr2','manager','h','00000000-0000-0000-0000-0000000000d1'),
 ('00000000-0000-0000-0000-0000000000c1','c1@x.fr','C1','commercial','h','00000000-0000-0000-0000-0000000000a1'),
 ('00000000-0000-0000-0000-0000000000c2','c2@x.fr','C2','commercial','h','00000000-0000-0000-0000-0000000000a1'),
 ('00000000-0000-0000-0000-0000000000c3','c3@x.fr','C3','commercial','h','00000000-0000-0000-0000-0000000000a2');
SELECT rebuild_hierarchy();
SELECT 'closure rows (attendu 6 + 5 + 3... voir)', count(*) FROM user_hierarchy;
INSERT INTO company(id,crm_id,name) VALUES ('00000000-0000-0000-0000-00000000f001','CRM1','Dupont');
INSERT INTO company_assignment(company_id,user_id) VALUES
 ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000c1'),
 ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000c3');
-- visite de c1 chez Dupont
INSERT INTO visit(id,company_id,author_id) VALUES ('00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000c1');
CREATE TEMP TABLE r(who text, mode int, can bool);
DO $$
DECLARE m int; u record;
BEGIN
 FOREACH m IN ARRAY ARRAY[2,1] LOOP
  UPDATE app_setting SET value=to_jsonb(m::text)::jsonb WHERE key='report_visibility_mode';
  FOR u IN SELECT id, display_name FROM app_user ORDER BY display_name LOOP
    INSERT INTO r VALUES (u.display_name, m, can_read_visit(u.id,'00000000-0000-0000-0000-00000000e001'));
  END LOOP;
 END LOOP;
END $$;
SELECT who, max(can::int) FILTER (WHERE mode=2) AS mode2, max(can::int) FILTER (WHERE mode=1) AS mode1 FROM r GROUP BY who ORDER BY who;
-- seq : incrémenté et updated_at
SELECT seq>0 AS seq_ok FROM visit WHERE id='00000000-0000-0000-0000-00000000e001';
-- contraintes : assignation d'action à un autre refusée (MVP)
SAVEPOINT s; 
-- Attendu (mode 2 / mode 1) pour la visite de C1 chez Dupont (C1 et C3 affectés, Mgr dirige C1 et C2, Mgr2 dirige C3) :
--   C1 1/1, C2 0/0, C3 0/1, Mgr 1/1, Mgr2 0/1, Dir 1/1
-- Une assignation d'action à un autre utilisateur doit être refusée tant que la contrainte du MVP existe :
SAVEPOINT s;
DO $$ BEGIN
  BEGIN
    INSERT INTO action_item(id,company_id,author_id,owner_id,title) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c2','x');
    RAISE EXCEPTION 'la contrainte owner_id = author_id aurait dû refuser cette ligne';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
