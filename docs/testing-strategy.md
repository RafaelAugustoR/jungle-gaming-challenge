# Estratégia de testes

Escopo aprovado no grill em 2026-11-11. Bun será o test runner do projeto. O desenvolvimento seguirá ciclos incrementais de teste que falha, implementação e verificação.

## Interfaces acordadas

| Interface | Evidências |
| --- | --- |
| Métodos públicos do domínio | Money, transições, moedas, reversões e invariantes. |
| HTTP e Keycloak | Autenticação, autorização, contratos, idempotência e consultas. |
| Entrada e saída SQS | Inbox, eventos, redelivery, retry e DLQ. |
| Schema PostgreSQL | Constraints, imutabilidade, partidas balanceadas e migrations reversíveis. |
| Aplicação em múltiplos processos | Disputa de saldo, duplicatas, publishers concorrentes e recuperação após morte de worker. |
| Frontend no navegador | Login, restrições por perfil e um cenário financeiro completo. |

## Critérios

- PostgreSQL e SQS reais em containers nos testes de integração, sem substituição completa por mocks.
- Pelo menos três processos da aplicação; concorrência do test runner sozinha não satisfaz esse requisito.
- Falhas provocadas em pontos controlados, incluindo após commit e antes de ack, com coordenação explícita em vez de sleeps arbitrários.
- Verificação final de igualdade entre saldo materializado e saldo reconstruído pelo ledger, além de balanceamento das partidas.
- Testes de constraints usam a fronteira SQL deliberadamente; testes de comportamento preferem interfaces públicas.
- Todos os cenários obrigatórios da seção 13 devem estar demonstrados e rastreados na especificação.
- Relatório de carga com ambiente, metodologia, throughput, percentis, erros, conflitos e outbox lag; sem meta de RPS inventada.
- Execução reproduzível em ambiente limpo. Percentual de cobertura não substitui evidências dos cenários obrigatórios.

Referências: [README](https://github.com/junglegaming/backend-challenge), seções 13 e 14; [Bun test runner](https://bun.sh/docs/test).
