# Jungle Gaming — Distributed Wagering Processor

Solução em desenvolvimento para o [backend challenge da Jungle Gaming](https://github.com/junglegaming/backend-challenge).

## Estado atual

O grill de arquitetura foi concluído e a especificação está publicada na [Issue #1](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/1). Este repositório contém documentação de planejamento; a aplicação, os comandos de execução e os testes ainda serão implementados. Não há resultados de benchmark ou garantias verificadas de execução nesta etapa.

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

O projeto usa apenas dados de demonstração e não integra dinheiro real. Setup, migrations, testes e execução local serão documentados à medida que forem implementados e verificados.
