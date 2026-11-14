// Base tokens and controls load first so component styles can build on them.
import './base.css';
import Keycloak from 'keycloak-js';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { createApi, type Api } from './api';
import { Console } from './console';
import { highestRole, type Role } from './roles';
import { Landing, TopBar } from './shell';

interface Session {
  identity: Keycloak;
  api: Api;
  username: string;
  role: Role;
}

type BootState = 'connecting' | 'ready' | 'error' | 'no-access';

function App() {
  const [identity, setIdentity] = useState<Keycloak>();
  const [session, setSession] = useState<Session>();
  const [state, setState] = useState<BootState>('connecting');

  useEffect(() => {
    (async () => {
      const response = await fetch('/console-config');
      if (!response.ok) throw new Error('config');
      const keycloak = new Keycloak(await response.json());
      const authenticated = await keycloak.init({
        onLoad: 'check-sso',
        pkceMethod: 'S256',
        checkLoginIframe: false,
        responseMode: 'query',
      });
      setIdentity(keycloak);
      if (!authenticated) return setState('ready');
      const role = highestRole((name) => keycloak.hasRealmRole(name));
      if (!role) return setState('no-access');
      setSession({
        identity: keycloak,
        api: createApi(keycloak),
        username: keycloak.tokenParsed?.preferred_username ?? 'usuário',
        role,
      });
      setState('ready');
    })().catch(() => setState('error'));
  }, []);

  const logout = () => void identity?.logout({ redirectUri: location.origin });
  return (
    <>
      <a class="skip" href="#conteudo">
        Pular para o conteúdo
      </a>
      <TopBar user={session} onLogout={logout} />
      {session ? (
        <Console api={session.api} role={session.role} />
      ) : state === 'no-access' ? (
        <main class="landing" id="conteudo">
          <section class="landing-copy">
            <h1>Seu usuário não tem acesso ao console.</h1>
            <p class="lede">
              Entre com um dos perfis de demonstração: viewer, operator ou demo-operator.
            </p>
            <button class="primary" type="button" onClick={logout}>
              Sair e trocar de usuário
            </button>
          </section>
        </main>
      ) : (
        <main id="conteudo">
          <Landing
            state={state === 'error' ? 'error' : state === 'connecting' ? 'connecting' : 'ready'}
            onLogin={() => void identity?.login({ redirectUri: location.href })}
          />
        </main>
      )}
    </>
  );
}

render(<App />, document.getElementById('app')!);
