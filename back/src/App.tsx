import { useEffect, useState } from 'react';
import { api, brand, hasSession, login, logout, onLogout, type R } from './api';
import { Alert, errMsg } from './ui';
import { Reporting } from './pages/Reporting';
import { Preparation } from './pages/Preparation';
import { Visits } from './pages/Visits';
import { Accounts } from './pages/Accounts';
import { Clients } from './pages/Clients';

export interface Me { id: string; email: string; display_name: string; role: string; is_admin: boolean }
type Brand = { name: string; logo: string | null };

const PAGES = [
  { id: 'reporting', label: 'Reporting', icon: '📊' },
  { id: 'preparation', label: 'Préparation', icon: '🗓️' },
  { id: 'visites', label: 'Visites', icon: '📋' },
  { id: 'comptes', label: 'Comptes', icon: '👥', admin: true },
  { id: 'clients', label: 'Clients (maquette CRM)', icon: '🏢', admin: true },
] as const;

const useRoute = () => {
  const [h, setH] = useState(location.hash);
  useEffect(() => { const f = () => setH(location.hash); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const [path, query = ''] = h.replace(/^#\/?/, '').split('?');
  return { page: path || 'reporting', params: new URLSearchParams(query) };
};

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'login' | 'ready'>(hasSession() ? 'loading' : 'login');
  const [b, setB] = useState<Brand>({ name: 'Visites commerciales', logo: null });
  useEffect(() => { void brand().then(setB); }, []);
  useEffect(() => { document.title = `${b.name} – Back office`; }, [b.name]);
  onLogout.cb = () => { setMe(null); setState('login'); };
  useEffect(() => {
    if (state !== 'loading') return;
    api<Me>('me').then(m => { setMe(m); setState('ready'); }).catch(() => setState('login'));
  }, [state]);

  if (state === 'loading') return <p className="empty">Chargement…</p>;
  if (state === 'login' || !me) return <Login brand={b} onDone={() => setState('loading')} />;
  return <Shell me={me} brand={b} />;
}

function Login({ brand: b, onDone }: { brand: Brand; onDone: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(undefined);
    try { await login(email.trim(), password); onDone(); }
    catch (x: any) { setErr(x.code === 'invalid_credentials' ? 'Identifiants incorrects.' : x.code === 'account_locked' ? 'Compte verrouillé, réessayez plus tard.' : errMsg(x)); }
    finally { setBusy(false); }
  };
  return (
    <main className="login">
      <form onSubmit={submit} className="card">
        {b.logo && <img src={b.logo} alt={`Logo ${b.name}`} className="login-logo" />}
        <h1>{b.name}</h1>
        <p className="muted">Back office</p>
        <label className="field"><span>E-mail</span><input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required autoFocus /></label>
        <label className="field"><span>Mot de passe</span><input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
        {err && <Alert>{err}</Alert>}
        <button className="primary" disabled={busy || !email || !password}>{busy ? 'Connexion…' : 'Se connecter'}</button>
      </form>
    </main>
  );
}

function Shell({ me, brand: b }: { me: Me; brand: Brand }) {
  const { page, params } = useRoute();
  const pages = PAGES.filter(p => !('admin' in p && p.admin) || me.is_admin);
  const current = pages.find(p => p.id === page) ?? pages[0]!;
  const role = me.is_admin ? 'Administrateur' : me.role === 'commercial' ? 'Commercial' : me.role === 'manager' ? 'Manager' : 'Directeur';
  return (
    <div className="shell">
      <aside>
        <div className="brand">{b.logo && <img src={b.logo} alt={`Logo ${b.name}`} />}<strong>{b.name}</strong></div>
        <nav aria-label="Navigation">
          {pages.map(p => <a key={p.id} href={`#/${p.id}`} className={p.id === current.id ? 'on' : ''} aria-current={p.id === current.id ? 'page' : undefined}><span aria-hidden>{p.icon}</span>{p.label}</a>)}
        </nav>
        <div className="spacer" />
        <div className="who"><strong>{me.display_name}</strong><small>{role}</small><button className="link" onClick={() => void logout().then(() => location.reload())}>Se déconnecter</button></div>
      </aside>
      <main>
        {current.id === 'reporting' && <Reporting me={me} />}
        {current.id === 'preparation' && <Preparation me={me} params={params} />}
        {current.id === 'visites' && <Visits me={me} params={params} />}
        {current.id === 'comptes' && <Accounts me={me} />}
        {current.id === 'clients' && <Clients />}
      </main>
    </div>
  );
}

export type { R };
