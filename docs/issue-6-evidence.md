# Issue #6 — Referências pendentes

## Escopo

Atende R08, R10, R11, R16, R20 e R24: referências fora de ordem, processamento concorrente, retries duráveis, expiração determinística e resultado auditável. O aceite 202 é imutável; a consulta apresenta a conclusão atual. O worker reutiliza as regras financeiras de WIN/LOSS/REFUND/ROLLBACK da Issue #5.

## Implementação

- Migration 0005 cria `wagering.reference_retries`, incluindo deadline, próxima tentativa, contador e contexto original. O saldo do resultado fica em `transactions.result_balance`, preenchido nos dois caminhos e recuperado dos recibos existentes na atualização. Pendências anteriores são recuperadas com deadline original +15 minutos.
- O aceite persiste agenda, recibo e evento na mesma transação SQL. Replays não alteram agenda.
- `reference-worker` é processo independente e usa horário PostgreSQL. Backoff exponencial com jitter de 50–100% é limitado pelo deadline durante a espera de negócio. Falha de infraestrutura agenda nova tentativa futura mesmo após TTL, sem renovar o deadline de negócio nem inventar resultado terminal. Configuração está documentada no README.
- A varredura não mantém locks. Cada candidato adquire primeiro o lock da wallet e revalida status/agenda/referência. Submissões, resolução e expiração usam a mesma ordem de lock. Repetir candidato concluído não repete efeito/evento.
- Uma referência processada até o prazo permite conclusão após atraso do worker. Referência tardia ou ainda pendente gera `REFERENCE_NOT_READY`; ausência gera `REFERENCE_NOT_FOUND`. Rejeição/falha da referência e incompatibilidades mantêm códigos específicos. Infraestrutura nunca se converte em ausência de referência.
- A política de espera tem provider único e é injetada nos casos de uso; o repositório somente persiste agenda/contexto fornecidos. Regras puras de referência concentram expiração e preservam o ID conhecido.
- Falhas são isoladas por candidato, registradas em log e adiadas em outra transação; não impedem o restante do lote. Não há limite arbitrário que converta indisponibilidade ou um bug em `FAILED`: ADR 0011 exige evidência persistida para decidir o resultado.
- Conclusão, partidas, saldo, agenda e outbox confirmam atomicamente. SIGTERM interrompe o polling e drena apenas a transação atual; a próxima execução retoma agenda persistida.

## Evidências reproduzíveis

```sh
bun test tests/unit/reference-retry.test.ts tests/unit/settlement.test.ts
INTEGRATION=1 bun test tests/integration/pending-references.test.ts
bun run build
bun run test:integration
```

`pending-references.test.ts` usa PostgreSQL e Keycloak reais, bancos descartáveis e portas HTTP efêmeras. O relógio de vencimento é controlado pela agenda SQL de teste, sem aguardar quinze minutos.

| Cenário                                                                 | Evidência                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Backoff/jitter e limite pelo TTL                                        | Teste público da política, red→green inicialmente falhou por módulo ausente.                                        |
| Entrada pendente, retry sem evento repetido, GET concluído e replay 202 | HTTP + auditoria de journal/outbox e deadline inalterado.                                                           |
| WIN/LOSS/REFUND/ROLLBACK antes da origem                                | Seis reprocessadores concorrentes, resultado único e saldo reconstruído.                                            |
| Prazo: origem ausente, pendente, tardia, pontual e rejeitada            | Deadline controlado; códigos específicos e conclusão após polling atrasado.                                         |
| Falha durante gravação da outbox                                        | Trigger controlado causa rollback de estado, agenda, journal e saldo; retry seguinte conclui.                       |
| Infraestrutura falha durante expiração                                  | Lock real causa timeout; operação segue pendente e só expira depois de restaurado o acesso.                         |
| Reinício e três processos reais                                         | SIGKILL de worker com agenda persistida, três PIDs distintos retomam uma única conclusão.                           |
| Autorreferência e incompatibilidade conhecida                           | HTTP rejeita imediatamente; autorreferência não consome chave.                                                      |
| Estados REJECTED/FAILED da referência                                   | Domínio rejeita ambos com `REFERENCE_NOT_PROCESSED`.                                                                |
| Primeiro candidato com falha                                            | Falha SQL controlada no primeiro candidato; o segundo conclui no mesmo lote e o primeiro recebe backoff persistido. |
| Resultado financeiro e downgrade                                        | Backfill de recibo existente; saldo terminal imutável; down recusa apagar resultados de pendências concluídas.      |
| Migrations                                                              | Up/down/up em PostgreSQL descartável na suíte de infraestrutura.                                                    |

Verificação em 2026-11-13 após revisão: build e typecheck passaram; suíte geral sem containers: 34 testes aprovados, 62 ignorados, 185 assertions; integração/concorrência: 67 aprovados, 1 ignorado (navegador opt-in), 493 assertions. Casos direcionados de domínio/HTTP/schema: 13 aprovados, 106 assertions. A regressão de starvation falhou primeiro e passou após isolamento e backoff persistido; a regressão de expiração pura também foi red→green. A execução de três processos inclui interrupção e encerramento limpo; nenhum serviço compartilhado foi reiniciado.

## Limitação conhecida

Workers ainda varrem o mesmo top-N e podem disputar a mesma wallet. Os locks e a revalidação impedem duplicação; backoff por candidato evita que uma falha individual monopolize o lote. Claim por lease é uma otimização futura de distribuição, não requisito para a correção financeira desta issue.
