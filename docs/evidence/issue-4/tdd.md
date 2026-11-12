# Ciclos TDD — Issue #4

Interfaces já aprovadas em `docs/testing-strategy.md`; execução com Bun 1.3.14.

| Ciclo                             | Red observado                                                                                      | Green observado                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Domínio Wallet.debit              | `TypeError: wallet.debit is not a function`                                                        | BET 80/100 → 20, versão 2, journal balanceado; zero não muda; insuficiência e moeda incompatível falham. |
| Primeiro fluxo HTTP               | POST inexistente retornou 404 em vez de 200                                                        | POST BET + GET interno/externo + wallet/ledger reais passaram após implementação e migration 0003.       |
| Orçamento financeiro configurável | Config não continha `financialDeadlineMs`, `financialLockTimeoutMs`, `financialStatementTimeoutMs` | Defaults 15000/3000/5000, override e entradas inválidas passaram.                                        |
| Recibo 422 integralmente estável  | Replay retornava outro correlationId no corpo                                                      | CorrelationId do corpo persistido; somente flag de replay muda; header identifica transporte atual.      |

Regressões complementares cobrem hash pela ordem recursiva de chaves no HTTP, divergência, escopo, autorização, constraints, falhas SQL em cada etapa, timeouts e corridas reais. O harness também falhou inicialmente na observação de sessões; identificação por PID em application_name e consulta de espera corrigiram a coordenação, sem substituir o banco por mocks ou usar sleeps para ordenar as apostas. O polling curto apenas aguarda uma condição PostgreSQL explícita.
