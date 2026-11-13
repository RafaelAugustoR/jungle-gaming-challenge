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

A Issue #3 entrega autenticação, criação/consulta de wallet e ledger de abertura. `initialBalance` positivo confirma wallet, transação interna OPENING, journal e evento `WalletBalanceChanged` na mesma transação SQL. Abertura zero não gera transação, ledger ou evento. Em ambos os casos a versão inicial é 1. A Issue #4 acrescenta BET autenticada e idempotente, recibos estáveis e consultas de transações. As demais operações de apostas, publicação da outbox e reconciliação pertencem aos próximos tickets.

### Login e contratos

O navegador usa o adaptador oficial Keycloak com Authorization Code + PKCE S256. Tokens permanecem em memória. A API verifica assinatura RS256, issuer, audience `jungle-api`, expiração, cliente e perfis. Os clientes de máquina `provider-a` e `provider-b` usam Client Credentials e claims `providerId` distintos; não acessam wallets/ledger. O mapeamento de cliente para providerId vem de `PROVIDER_CLIENTS` (JSON; exemplo em `.env.example`), também repassado pelo Compose. O backend não mantém uma lista fixa de provedores no guard. Segredos locais respectivos: `provider-a-demo-only` e `provider-b-demo-only`. Não usar essas credenciais fora da demonstração local.

`POST /wallets` exige demo-operator e recebe:

```json
{ "playerId": "player-demo", "initialBalance": { "amount": "100.00", "currency": "BRL" } }
```

Retorna 201 com `id`, `playerId`, `balance: { amount, currency }` e `version`. `GET /wallets/:id` e `GET /wallets/:id/ledger` exigem perfil viewer (herdado por operator e demo-operator). Duplicação de jogador/moeda retorna 409; payload inválido 400; token ausente/inválido 401; permissão insuficiente 403; wallet inexistente 404. Respostas de erro incluem `code`, `message` e `correlationId`; o header `X-Correlation-Id` está presente também em respostas de sucesso.

O ledger retorna `{ entries, nextCursor }`. Cada entrada contém `id`, `transactionId`, `kind`, `direction`, `amount`, `currency`, `balanceBefore`, `balanceAfter`, `walletVersion`, `createdAt`; valores monetários são strings com duas casas. Limite padrão 50, máximo 100, cursor opaco vinculado à wallet e ao limite superior da primeira página. BET acrescenta um lançamento por débito positivo aprovado; rejeição, zero e replay não acrescentam entradas.

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

O PR #16 / Issue #3 foi mergeado com o baseline financeiro consolidado em 0002. A migration **0003** é incremental: acrescenta identidade externa, estados/transições, campos de falha/processamento e recibos, preservando as aberturas existentes. Up/down/up é validado em banco descartável. O down de 0003 recusa apagar metadados se já houver transações externas aceitas; não é um procedimento para desfazer apostas.

### BET idempotente — Issue #4

`POST /wagering/transactions` exige token de máquina vinculado ao `providerId` e header `Idempotency-Key` obrigatório (string não vazia de até 128 caracteres). Exemplo de corpo, substituindo wallet e jogador pelos dados de uma wallet criada:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-001",
  "playerId": "player-demo",
  "walletId": "00000000-0000-0000-0000-000000000001",
  "roundId": "round-001",
  "gameId": "game-001",
  "kind": "BET",
  "money": { "amount": "20.00", "currency": "BRL" }
}
```

O recibo contém `transactionId`, `status`, `balance: { amount, currency }` e `idempotentReplay`. Uma BET processada retorna 200; saldo insuficiente retorna 422 com `failureCode`, `code`, `message` e `correlationId`, sem débito. O mesmo provedor/chave/conteúdo retorna o recibo persistido, mudando somente `idempotentReplay`, mesmo após outras apostas ou reinício. No replay 422, o `correlationId` do corpo é original; `X-Correlation-Id` identifica o transporte atual. Payload divergente sob a mesma chave retorna 409 `IDEMPOTENCY_CONFLICT`, inclusive se trocar a wallet por um UUID válido inexistente; outra chave para a mesma identidade externa retorna 409 `EXTERNAL_TRANSACTION_CONFLICT`. Provedores diferentes têm escopos independentes.

`GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` retornam o estado persistido e resultado financeiro. Viewer/operator/demo-operator consultam; provedores consultam somente suas operações. Recurso de outro provedor retorna 404. Humanos não submetem apostas diretamente. OPENING e referências em BET são recusados com 400, assim como campos desconhecidos. Wallet ausente retorna 404; jogador ou moeda incompatíveis são validações anteriores ao aceite (400 `PLAYER_MISMATCH` / `CURRENCY_MISMATCH`) e não consomem a chave. Identidade incompatível retorna 403.

BET zero retorna 200 e evento de resultado, sem journal, incremento de versão ou evento de saldo. BET positiva aprovada incrementa a versão uma vez e confirma partidas dobradas, recibo e eventos de saldo/resultado na mesma transação. A outbox tem sequência própria por wallet; não publica nada durante o processamento financeiro.

Timeouts de lock/statement/prazo financeiro são configuráveis por `FINANCIAL_LOCK_TIMEOUT_MS` (3000), `FINANCIAL_STATEMENT_TIMEOUT_MS` (5000) e `FINANCIAL_DEADLINE_MS` (15000). A transação recebe até três tentativas em deadlock/serialização/timeout de lock, usando o orçamento restante; indisponibilidade retorna 503 e não consome a chave. Repita a mesma chave se o resultado do commit for incerto.

```sh
# Inclui PostgreSQL e Keycloak reais; bancos de teste são descartáveis:
bun run test:concurrency
# Integrações + concorrência (também na CI):
bun run test:integration
# Relatório JSON opcional dos três processos:
BET_EVIDENCE_PATH=/tmp/bet-concurrency.json bun run test:concurrency
```

O coordenador `SubmitWagerTransaction` compartilha transação, idempotência e persistência; apenas a etapa BET está habilitada. A entidade carrega identidade e resultado e produz recibo/evento tipados. CI publica logs e PIDs nos logs baixáveis da execução, sem versionar dados locais.

As provas usam três processos Bun da API com PIDs distintos e barreiras observáveis em `pg_stat_activity`, além de um lock controlado no banco. O harness cobre 50 duplicatas, disputa de saldo, wallets independentes, conflitos UNIQUE entre wallets e replay após reinício. [Evidências da Issue #4](docs/evidence/issue-4/README.md).

Veja [tratamento da revisão](docs/evidence/issue-3/review-follow-up.md) e [evidências da Issue #3](docs/evidence/issue-3/README.md) e [ARCHITECTURE.md](ARCHITECTURE.md).

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

### Referências pendentes — Issue #6

REFUND/ROLLBACK exigem referência; WIN/LOSS podem informar referência a BET. Quando a referência ainda não chegou ou está pendente, o aceite retorna 202 `PENDING_REFERENCE`, sem movimentar saldo. O replay mantém esse recibo original, inclusive depois da conclusão. Consulte os endpoints GET de transação para obter o estado e saldo do resultado atual.

O Compose inicia `reference-worker` em processo separado. Fora do Docker, execute `bun run worker:references` junto da API. Ambos usam o mesmo PostgreSQL; nenhum estado de retry depende da memória do processo. `REFERENCE_TTL_MS` (900000) fixa o prazo no aceite; `REFERENCE_BASE_MS` (1000) e `REFERENCE_MAX_MS` (30000) controlam backoff exponencial com jitter de 50–100%. `REFERENCE_POLL_MS` (500) e `REFERENCE_BATCH_SIZE` (50) controlam a varredura. Replays não prorrogam o prazo.

No vencimento, referência ausente gera `REFERENCE_NOT_FOUND`; existente mas ainda pendente ou processada após o prazo gera `REFERENCE_NOT_READY`. Uma referência processada dentro do prazo pode concluir mesmo se a varredura atrasar. Referência rejeitada/falha gera `REFERENCE_NOT_PROCESSED`; incompatibilidades conhecidas são rejeitadas sem aguardar TTL. Erros de infraestrutura preservam a pendência para nova tentativa. O worker serializa revalidação, expiração e partidas sob o mesmo lock de wallet das submissões; vários processos são seguros. Retry ainda pendente não duplica eventos; resultado terminal, journal, saldo e outbox confirmam atomicamente.

A migration 0005 adiciona a agenda persistente e recupera pendências preexistentes. Seu down recusa remover uma agenda ainda ativa ou resultados de pendências concluídas. Evidências reproduzíveis: `INTEGRATION=1 bun test tests/integration/pending-references.test.ts` e [relatório da Issue #6](docs/issue-6-evidence.md).

Falhas individuais no worker são registradas e adiadas em transação separada, permitindo que outros candidatos avancem no mesmo lote. Se o TTL já venceu, a tentativa de infraestrutura usa backoff futuro sem alterar o deadline original; a decisão de expiração espera acesso ao estado persistido. Não há limite arbitrário de retries que converta indisponibilidade em falha financeira. O saldo retornado pela consulta pertence a `transactions.result_balance`, separado do recibo original e da agenda. Workers ainda podem disputar o mesmo top-N; claim por lease fica como otimização futura, documentada no relatório.
