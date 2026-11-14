import { ErrorNote } from './fields';
import { Icon, Mark } from './icons';
import { proofs } from './proofs';
import { roleLabel, type Role } from './roles';
import { StateMark } from './ticket';
import './shell.css';

export function TopBar({
  user,
  onLogout,
}: {
  user?: { username: string; role: Role };
  onLogout?: () => void;
}) {
  return (
    <header class="topbar">
      <a class="brand" href="/" aria-label="Lastro, início">
        <Mark />
        <span>
          Lastro <span class="brand-sub">Console de prova</span>
        </span>
      </a>
      <div class="topbar-end">
        <span class="env">Dados fictícios · BRL</span>
        {user && (
          <>
            <span class="who">
              <strong>{user.username}</strong>
              <span>{roleLabel[user.role]}</span>
            </span>
            <button type="button" class="ghost" onClick={onLogout}>
              <Icon name="logout" />
              Sair
            </button>
          </>
        )}
      </div>
    </header>
  );
}

export function Landing({
  onLogin,
  state,
}: {
  onLogin: () => void;
  state: 'connecting' | 'ready' | 'error';
}) {
  return (
    <div class="landing">
      <section class="landing-copy">
        <h1>Cada garantia do processador de apostas, provada com os dados da execução.</h1>
        <p class="lede">
          O console dispara cenários reais pelo mesmo endpoint e com a mesma identidade de máquina
          dos provedores. Cada operação vira um bilhete: o recibo original no canhoto, o estado
          atual na via de validação.
        </p>
        <button class="primary large" type="button" onClick={onLogin} disabled={state !== 'ready'}>
          {state === 'connecting' ? 'Conectando ao login…' : 'Entrar'}
          <Icon name="arrow" />
        </button>
        {state === 'error' && (
          <ErrorNote
            error={
              new Error(
                'Não foi possível conectar ao serviço de login. Recarregue a página para tentar de novo.',
              )
            }
          />
        )}
        <dl class="profiles">
          <div>
            <dt>demo-operator</dt>
            <dd>cria wallets e executa as provas</dd>
          </div>
          <div>
            <dt>operator</dt>
            <dd>consulta e reconcilia</dd>
          </div>
          <div>
            <dt>viewer</dt>
            <dd>só consulta bilhetes e ledger</dd>
          </div>
        </dl>
      </section>
      <section class="landing-list" aria-labelledby="landing-proofs">
        <div class="landing-ticket">
          <header class="ticket-head">
            <h2 id="landing-proofs" class="ticket-label">
              O que você vai provar
            </h2>
            <span class="ticket-kind">5 GARANTIAS</span>
          </header>
          <ol>
            {proofs.map((proof) => (
              <li key={proof.id}>
                <StateMark tone="none" />
                <span class="landing-n num">{proof.number}</span>
                <span>
                  <strong>{proof.guarantee}</strong>
                  <span class="muted">{proof.short}</span>
                </span>
              </li>
            ))}
          </ol>
          <div class="perforation perforation-h" aria-hidden="true" />
          <p class="landing-stub">
            Canhoto: cada garantia recebe seu carimbo no console, com os recibos e o ledger daquela
            execução.
          </p>
        </div>
      </section>
    </div>
  );
}
