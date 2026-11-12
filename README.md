# Jungle Gaming — Distributed Wagering Processor

Solução em desenvolvimento para o [backend challenge da Jungle Gaming](https://github.com/junglegaming/backend-challenge).

## Execução local — Issue #2

Requisitos: Docker com Compose e, para desenvolvimento fora do container, Bun 1.3.14.

```sh
docker compose up -d --build
curl --fail http://localhost:3000/health/live
curl --fail http://localhost:3000/health/ready
```

A API usa a porta 3000; PostgreSQL 55439; SQS 4566; Keycloak 8080. Portas são publicadas apenas em loopback. As credenciais do Compose são públicas e exclusivas de demonstração local. Keycloak inicia em modo de desenvolvimento com `admin` / `local-demo-only`; integração de login será implementada na Issue #3.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun test
INTEGRATION=1 bun test
```

`bun test` executa testes HTTP e pula explicitamente os três testes que precisam de containers. `INTEGRATION=1 bun test` executa todos, usando PostgreSQL e SQS do Compose. Alternativa com Bun dentro do Docker:

```sh
docker compose --profile test run --build --rm tests
```

Configuração externa ao Docker usa os defaults de `.env.example`; copie para `.env` se precisar alterar. Dentro do Compose, os endpoints são definidos para a rede dos containers.

```sh
bun run migrate:up
bun run migrate:down
bun run migrate:up
bun run dev
```

As migrations criam o schema `wagering`. `migrate:down` é para desenvolvimento em banco descartável; os testes usam um banco temporário próprio. Para parar os serviços sem apagar o volume: `docker compose down`.

Este estágio implementa apenas o bootstrap. Wallets, processamento financeiro, autenticação da aplicação e console ainda não estão disponíveis. Veja [ARCHITECTURE.md](ARCHITECTURE.md) para limites e decisões.

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

O projeto usa apenas dados de demonstração e não integra dinheiro real. Os comandos acima cobrem o bootstrap; as demais entregas seguirão as Issues aprovadas.
