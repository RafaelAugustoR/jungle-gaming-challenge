# Jungle Gaming — Distributed Wagering Processor

Solução em desenvolvimento para o [backend challenge da Jungle Gaming](https://github.com/junglegaming/backend-challenge).

## Execução local

Requisitos: Docker com Compose e, para desenvolvimento fora do container, Bun 1.3.14.

```sh
docker compose up -d --build
curl --fail http://localhost:3000/health/live
curl --fail http://localhost:3000/health/ready
```

O Compose aplica migrations antes de iniciar a API. A API usa a porta 3000; PostgreSQL 55439; SQS 4566; Keycloak 18080. Portas são publicadas apenas em loopback. As credenciais do Compose são públicas e exclusivas de demonstração local. Abra **http://localhost:3000** para acessar o console. Keycloak importa o realm `jungle` com os usuários `viewer`, `operator` e `demo-operator`, todos com senha local `demo-only`. Use `demo-operator` para criar wallets; os demais perfis consultam. Administração local: `admin` / `local-demo-only`.

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run typecheck
bun run build
bun test
INTEGRATION=1 bun test
```

`bun test` executa domínio e HTTP com fixture de chaves do IdP e pula explicitamente os testes que precisam de containers. `INTEGRATION=1 bun test` executa todos, usando PostgreSQL, SQS e Keycloak do Compose. Alternativa com Bun dentro do Docker:

```sh
docker compose --profile test run --build --rm tests
```

Antes dos comandos Bun fora do Docker, copie `.env.example` para `.env`: `cp .env.example .env`. Configuração obrigatória ausente ou inválida interrompe o boot com mensagem sanitizada. Dentro do Compose, os endpoints são definidos para a rede dos containers.

```sh
bun run migrate:up
bun run migrate:down
bun run migrate:up
bun run build:frontend
bun run dev
```

As migrations criam o schema `wagering`. `migrate:down` é para desenvolvimento em banco descartável; os testes usam um banco temporário próprio. Para parar os serviços sem apagar o volume: `docker compose down`.

A Issue #3 entrega autenticação, criação/consulta de wallet e ledger de abertura. `initialBalance` positivo confirma wallet, transação interna OPENING, journal e evento `WalletBalanceChanged` na mesma transação SQL. Abertura zero não gera transação, ledger ou evento. Em ambos os casos a versão inicial é 1. BET e demais operações de apostas, publicação da outbox e reconciliação pertencem aos próximos tickets.

### Login e contratos

O navegador usa o adaptador oficial Keycloak com Authorization Code + PKCE S256. Tokens permanecem em memória. A API verifica assinatura RS256, issuer, audience `jungle-api`, expiração, cliente e perfis. Os clientes de máquina `provider-a` e `provider-b` usam Client Credentials e claims `providerId` distintos; não acessam wallets/ledger. Segredos locais respectivos: `provider-a-demo-only` e `provider-b-demo-only`. Não usar essas credenciais fora da demonstração local.

`POST /wallets` exige demo-operator e recebe:

```json
{ "playerId": "player-demo", "initialBalance": { "amount": "100.00", "currency": "BRL" } }
```

Retorna 201 com `id`, `playerId`, `balance: { amount, currency }` e `version`. `GET /wallets/:id` e `GET /wallets/:id/ledger` exigem perfil viewer (herdado por operator e demo-operator). Duplicação de jogador/moeda retorna 409; payload inválido 400; token ausente/inválido 401; permissão insuficiente 403; wallet inexistente 404. Respostas de erro incluem `code`, `message` e `correlationId`; o header `X-Correlation-Id` está presente também em respostas de sucesso.

O ledger retorna `{ entries, nextCursor }`. Cada entrada contém `id`, `transactionId`, `kind`, `direction`, `amount`, `currency`, `balanceBefore`, `balanceAfter`, `walletVersion`, `createdAt`; valores monetários são strings com duas casas. Limite padrão 50, máximo 100, cursor opaco vinculado à wallet e ao limite superior da primeira página. Este recorte tem no máximo um lançamento por wallet.

### Credenciais de banco e testes

`DATABASE_URL` é do usuário restrito `jungle_runtime`. `MIGRATION_DATABASE_URL` é administrativa, usada pelo CLI de migrations e pelo harness para criar bancos descartáveis. A API do Compose recebe somente a URL de runtime. O serviço `provision` cria esse papel antes das migrations, inclusive em volumes existentes. Runtime não é dono das tabelas e não pode executar DDL nem alterar/excluir/truncar o journal. Não execute `migrate:down` no banco que contém dados que deseja preservar.

Para desenvolvimento local, copie `.env.example` e mantenha essas identidades separadas. O Compose define os endpoints internos e verifica tokens com o issuer público, usando o endpoint JWKS interno. Alterar o endereço público exige ajustar issuer, redirect URIs e web origins do realm. O import ocorre na criação do realm; para alterar um realm já importado, use a administração do Keycloak ou recrie apenas seu container de demonstração (ele não tem volume persistente).

```sh
# Requer Compose com PostgreSQL, SQS, Keycloak e provision prontos:
INTEGRATION=1 bun test
# Navegador Chromium instalado uma vez:
bunx playwright install --with-deps chromium
bun run test:browser
# Alternativa com Chrome já instalado:
CHROME_PATH=/usr/bin/google-chrome bun run test:browser
```

O teste de navegador exige a API/console do Compose na porta 3000. `CONSOLE_URL` permite escolher outra URL já autorizada no realm. As integrações usam bancos descartáveis e não deixam wallets no banco de demonstração; o teste de navegador cria dados fictícios no console. `build` verifica tipos e gera `frontend/dist` com Bun. Prettier está fixado no lockfile; use `bunx prettier --write caminho/do/arquivo` para formatar os arquivos alterados. O Docker também gera os assets, sem servidor frontend separado.

Veja [evidências da Issue #3](docs/evidence/issue-3/README.md) e [ARCHITECTURE.md](ARCHITECTURE.md).

## Documentação

- [Especificação e matriz de requisitos](docs/spec.md)
- [Glossário](CONTEXT.md)
- [Decisões arquiteturais](docs/adr/)
- [Resumo do grill](docs/grill-summary.md)
- [Estrutura aprovada](docs/project-structure.md)
- [Estratégia de testes](docs/testing-strategy.md)
- [Experimento de carga](docs/load-testing.md)
- [Observabilidade](docs/observability.md)
- [Entrega e demonstração](docs/delivery.md)

## Direção técnica

Monólito modular NestJS/TypeScript em Bun, MikroORM, PostgreSQL e SQS, com processos separados para API e workers. O escopo inclui ledger de partidas dobradas, idempotência persistente, inbox/outbox, Keycloak, console operacional e evidências de concorrência e recuperação de falhas.

O projeto usa apenas dados de demonstração e não integra dinheiro real. `build` verifica tipos; Bun executa o mesmo fonte em desenvolvimento, testes e Docker.

Os comandos acima cobrem o bootstrap; as demais entregas seguirão as Issues aprovadas.
