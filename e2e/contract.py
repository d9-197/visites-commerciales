#!/usr/bin/env python3
"""Contrat de l'API back : compare les réponses réelles du serveur aux schémas de api/back.openapi.yaml
(champs inconnus du schéma, champs obligatoires absents, types, énumérations). Sort avec le code 1 au moindre écart.

Prérequis : back démarré avec les données de démonstration (seed) ; Python 3 avec PyYAML.
Les écritures (comptes, clients, contacts, import en aperçu, réglage de visibilité) créent des données de test dans la base visée : à ne pas lancer sur une base de production.
Les réponses d'erreur ne sont pas comparées au schéma. Seules les données présentes sont vérifiées (une base vide ne couvre pas les listes).
Usage : BASE_URL=http://127.0.0.1:3000 python3 e2e/contract.py
"""
import os
import json, sys, yaml, urllib.request, urllib.error, time
B=os.environ.get('BASE_URL','http://127.0.0.1:3000').rstrip('/')
PWD=os.environ.get('SEED_PASSWORD','demo-mot-de-passe-12')
ROOT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','api')
spec=yaml.safe_load(open(os.path.join(ROOT,'back.openapi.yaml'))); common=yaml.safe_load(open(os.path.join(ROOT,'common.yaml')))
def ref(r):
    f,_,p=r.partition('#'); d=common if f.startswith('common') else spec
    for k in p.strip('/').split('/'): d=d[k]
    return d
def norm(s):
    if '$ref' in s: return norm(ref(s['$ref']))
    if 'allOf' in s:
        out={'type':'object','properties':{},'required':[]}
        for x in s['allOf']:
            x=norm(x); out['properties'].update(x.get('properties',{})); out['required']+=x.get('required',[])
        return out
    return s
problems=[]
def check(v, s, path):
    s=norm(s)
    if 'oneOf' in s:
        opts=[norm(o) for o in s['oneOf']]
        if v is None: 
            if any(o.get('type')=='null' for o in opts): return
        else:
            for o in opts:
                if o.get('type')!='null': check(v,o,path); return
        return
    t=s.get('type')
    ts=t if isinstance(t,list) else [t] if t else []
    py={'string':str,'integer':int,'number':(int,float),'boolean':bool,'array':list,'object':dict,'null':type(None)}
    if ts and not any(isinstance(v,py[x]) and not (x in('integer','number') and isinstance(v,bool)) for x in ts if x in py):
        problems.append(f'{path}: type {type(v).__name__} attendu {ts}'); return
    if isinstance(v,dict) and (s.get('properties') is not None):
        for k in v:
            if k not in s['properties']: problems.append(f'{path}.{k}: absent du schéma')
        for k in s.get('required',[]):
            if k not in v: problems.append(f'{path}.{k}: requis mais absent')
        for k,sub in s['properties'].items():
            if k in v: check(v[k],sub,f'{path}.{k}')
    if isinstance(v,list) and 'items' in s:
        for i,x in enumerate(v[:5]): check(x,s['items'],f'{path}[{i}]')
    if 'enum' in s and v not in s['enum']: problems.append(f'{path}: valeur {v!r} hors enum')
def call(m,path,tok,body=None):
    req=urllib.request.Request(B+path,method=m,data=json.dumps(body).encode() if body is not None else None,headers={'content-type':'application/json','authorization':'Bearer '+tok,'x-app-version':'1.0.0'})
    try: r=urllib.request.urlopen(req); return r.status,json.loads(r.read() or 'null')
    except urllib.error.HTTPError as e: return e.code,json.loads(e.read() or 'null')
def login(e):
    req=urllib.request.Request(B+'/api/mobile/v1/auth/login',method='POST',data=json.dumps({'email':e,'password':PWD,'device':{'platform':'web','app_version':'1.0.0'}}).encode(),headers={'content-type':'application/json'})
    return json.loads(urllib.request.urlopen(req).read())['access_token']
def resp_schema(path,method,code='200'):
    r=spec['paths'][path][method]['responses'][code]
    return r['content']['application/json']['schema']
adm=login('admin@exemple.invalid'); mgr=login('manager@exemple.invalid'); dirt=login('directeur@exemple.invalid')
api='/api/back/v1'

# Jeu de données : une visite terminée avec notes, compte rendu validé, action prévue et note interne (créés par l'application mobile, comme en usage réel),
# plus une visite planifiée depuis le back, pour que les schémas des listes et du détail soient exercés avec des données.
import uuid as _uuid
def push(tok, ops):
    st,b=call('POST','/api/mobile/v1/sync/push',tok,{'operations':[{'id':str(_uuid.uuid4()),'entity':e,'entity_id':i,'op':o,'payload':p,**({'base_version':v} if v else {})} for (e,i,o,p,v) in ops]})
    assert st==200 and all(r['result']=='applied' for r in b['results']), b
c1=login('commercial1@exemple.invalid')
st,cos=call('GET','/api/back/v1/prep/companies?q=Dupont',adm); company=cos['companies'][0]['id']
vid=str(_uuid.uuid4()); rid=str(_uuid.uuid4())
push(c1,[('visit',vid,'create',{'company_id':company,'status':'in_progress','objective':'Contrat','location_text':'1 rue du Test'},None),
  ('note',str(_uuid.uuid4()),'create',{'visit_id':vid,'kind':'text','body':'Note durant visite'},None),
  ('internal_note',str(_uuid.uuid4()),'create',{'visit_id':vid,'body':'Note interne : ne doit jamais sortir'},None),
  ('visit',vid,'update',{'status':'done'},1),
  ('report',rid,'create',{'visit_id':vid,'language':'fr','summary':'Résumé','needs':'Besoin','next_step':'Devis','opportunity_temperature':'hot','status':'validated',
    'draft_actions':[{'id':str(_uuid.uuid4()),'title':'Envoyer le devis','due_date':None,'origin':'manual'}]},None)])
st,_=call('POST','/api/back/v1/prep/visits',adm,{'company_id':company,'user_id':cos and call('GET','/api/back/v1/prep/commerciaux?company_id='+company,adm)[1]['users'][0]['id'],'planned_start':'2030-01-15T09:00:00Z','objective':'Planifiée','preparation_notes':'Apporter le catalogue'})
assert st==201
def t(m,tmpl,real,tok,code='200',body=None,label=None):
    st,b=call(m,api+real,tok,body)
    if str(st)!=code: problems.append(f'{m} {tmpl}: statut {st} (attendu {code}) {str(b)[:120]}'); return b
    check(b,resp_schema(tmpl,m.lower(),code),label or f'{m} {tmpl}'); return b
t('GET','/me','/me',adm)
rep=t('GET','/reports/activity','/reports/activity?from=2026-01-01&to=2026-12-31',dirt)
t('GET','/reports/activity','/reports/activity',adm,label='admin')
t('GET','/prep/commerciaux','/prep/commerciaux',mgr)
t('GET','/prep/companies','/prep/companies?q=D',adm)
sug=t('GET','/prep/suggestions','/prep/suggestions?days=7&include_planned=true',adm)
assert any(x['id']==company for x in sug['suggestions']), 'la fiche de préparation doit être exercée avec des visites'
cid=sug['suggestions'][0]['id'] if sug['suggestions'] else None
fiche=t('GET','/prep/companies/{id}',f'/prep/companies/{company}',adm)
assert fiche['visits'] and any(v['report'] for v in fiche['visits']) and fiche['open_actions'], 'fiche vide'
t('GET','/prep/visits','/prep/visits',adm)
st,_=call('POST','/api/back/v1/prep/visits',adm,{'company_id':company,'objective':'Non attribuée','node_id':fiche['visits'][0]['org_node_id']})   # préparation sans commercial ni date
assert st==201, st
pv=t('GET','/prep/visits','/prep/visits?user_id=none&late=false',adm,label='non attribuées')
assert pv['visits'] and pv['visits'][0]['author_id'] is None, 'visite non attribuée attendue'
t('GET','/prep/visits','/prep/visits?status=planned&company_ids='+company,adm,label='filtre clients')
t('GET','/prep/assignees',f'/prep/assignees?company_id={company}',adm)
t('PATCH','/prep/visits/{id}',f'/prep/visits/{pv["visits"][0]["id"]}',adm,body={'objective':'Modifiée'})
vs=t('GET','/visits','/visits?limit=5',adm)
vd=t('GET','/visits/{id}',f'/visits/{vid}',adm)
assert vd['report'] and vd['actions'] and vd['notes'] and vd['history'], 'détail de visite incomplet'
assert 'ne doit jamais sortir' not in json.dumps(vd) and 'ne doit jamais sortir' not in json.dumps(fiche), 'note interne exposée'
t('GET','/users','/users',adm)
t('GET','/settings','/settings',adm)
cs=t('GET','/companies','/companies?limit=3',adm)
t('GET','/companies/{id}',f"/companies/{cs['companies'][0]['id']}",adm)
# écritures
# organisation : lecture, création / renommage / suppression d'une sous-branche
mine=t('GET','/org/mine','/org/mine',adm)
root=mine['access'][0]['id']
t('GET','/org/mine','/org/mine',mgr,label='manager')
t('GET','/org','/org',adm)
nd=t('POST','/org/nodes','/org/nodes',adm,'201',{'name':f'Contrat {time.time_ns()}','parent_id':root})
t('PATCH','/org/nodes/{id}',f"/org/nodes/{nd['id']}",adm,'200',{'name':f'Contrat renommée {time.time_ns()}'})
rep2=t('GET','/reports/activity',f"/reports/activity?from=2026-01-01&to=2026-12-31&node_id={root}",adm,label='node_id')
assert rep2['by_node'] and rep2['node_id']==root, 'consolidation par branche absente'
t('DELETE','/org/nodes/{id}',f"/org/nodes/{nd['id']}",adm,'200')
u=t('POST','/users','/users',adm,'201',{'email':f'contrat{time.time_ns()}@exemple.invalid','display_name':'Contrat','role':'commercial','node_ids':[root]})
t('PATCH','/users/{id}',f"/users/{u['user']['id']}",adm,'200',{'display_name':'Contrat 2'})
rp=t('POST','/users/{id}/reset-password',f"/users/{u['user']['id']}/reset-password",adm,'200',{})
co=t('POST','/companies','/companies',adm,'201',{'name':f'Contrat SA {time.time_ns()}'})
t('PATCH','/companies/{id}',f"/companies/{co['id']}",adm,'200',{'city':'Nice'})
t('PUT','/companies/{id}/assignments',f"/companies/{co['id']}/assignments",adm,'200',{'user_ids':[]})
ct=t('POST','/companies/{id}/contacts',f"/companies/{co['id']}/contacts",adm,'201',{'full_name':'X Y'})
t('PATCH','/contacts/{id}',f"/contacts/{ct['id']}",adm,'200',{'job_title':'DG'})
t('DELETE','/contacts/{id}',f"/contacts/{ct['id']}",adm,'200')
t('POST','/import','/import',adm,'200',{'companies_csv':'crm_id;name\nCT-9;Test\n','dry_run':True})
t('PUT','/settings','/settings',adm,'200',{'report_visibility_mode':2})
print('données vérifiées :', len(sug['suggestions']), 'suggestions,', len(vs['visits']), 'visites,', len(rep['by_user']), 'commerciaux,', len(cs['companies']), 'clients')
if problems:
    print('ÉCARTS :'); print('\n'.join(' - '+p for p in problems)); sys.exit(1)
print('Contrat back : OK')
