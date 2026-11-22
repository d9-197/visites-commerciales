import { useState } from 'react';
import type { Me } from '../App';
import { Accounts } from './Accounts';
import { Organisation } from './Organisation';
import { Clients } from './Clients';

const TABS = [['organisation', 'Organisation'], ['comptes', 'Comptes'], ['clients', 'Clients (maquette CRM)']] as const;

/** Administration (administrateurs) : organisation, comptes, clients du faux CRM. */
export function Administration({ me, params }: { me: Me; params: URLSearchParams }) {
  const [tab, setTab] = useState<string>(TABS.some(t => t[0] === params.get('tab')) ? params.get('tab')! : 'organisation');
  return (
    <>
      <div className="tabs" role="tablist" aria-label="Administration">
        {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === 'organisation' && <Organisation />}
      {tab === 'comptes' && <Accounts me={me} />}
      {tab === 'clients' && <Clients />}
    </>
  );
}
