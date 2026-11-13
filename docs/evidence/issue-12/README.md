# Issue #12 — recuperação integrada

O [README original](../../research/challenge-readme.md), §13, pede 50 duplicatas,
disputa de saldo, wallets independentes, ≥3 processos, morte após commit/pré-ack,
dois publishers, referência antecipada e reinício com consistência final.
A Issue #12 reúne essas provas sobre PostgreSQL e SQS reais, sem alterar o contrato
financeiro ou as ADRs aprovadas.

## Reproduzir

Bun 1.3.14; PostgreSQL 16.6, LocalStack 4.0.3 e Keycloak 26.0.7 do Compose.

```sh
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait postgres sqs keycloak
docker compose run --rm provision
bun run build
bun run test:recovery
```

O usuário de migrations precisa criar bancos descartáveis. Nenhuma fila de negócio
é reutilizada; todos os nomes têm UUID, APIs/proxies usam portas efêmeras e os
clientes afetados por falha apontam apenas para seus proxies. Não se usa
`docker compose down`, bloqueio de rede global ou alteração de callbacks Keycloak.

`test:recovery` executa quatro fases sequenciais, interrompe na primeira falha e
grava `summary.json`, logs por fase, `http-concurrency.json` e `integrated.json` em
`artifacts/recovery/` (configurável por `RECOVERY_ARTIFACT_DIR`). Os JSONs de sucesso
são limpos antes da execução. A CI existente executa o cenário integrado em
`test:integration` e imprime `RECOVERY_EVIDENCE` no log do job.

## Matriz de provas

| Critério | Evidência executável |
| --- | --- |
| R02 | Todas as migrations up/down até zero/up no mesmo banco; schemas removidos, lista restaurada, inbox incompleta e saldo sem ledger recusados após restore. Suites anteriores ampliam constraints, imutabilidade e estados. |
| R12 | HTTP e SQS disputam duas BET 80 sobre 100; barreira SQL segura ambas antes de liberar. Uma PROCESSED, uma REJECTED, saldo 20. |
| R13/R14 | 25 HTTP + 25 SQS da mesma operação; três PIDs API e um consumidor bloqueados simultaneamente no PostgreSQL. São 25 IDs de mensagem distintos, sem depender do dedup FIFO. Uma transação, um débito, 25 inboxes. |
| R14 | BET de outra wallet conclui via SQS enquanto a primeira permanece bloqueada via HTTP. |
| R16 | Triggers falham, uma por vez, em transactions, wallet update, journal, receipt, inbox e outbox. Snapshot de todas essas tabelas/saldos permanece idêntico; a mesma entrega recupera sem reinjeção. |
| R17/R24 | IPC confirma pós-commit/pré-ack; SIGKILL e novo PID recebem a mesma mensagem, sem duplicar débito. API também reinicia e repete recibo persistido. |
| Referências | REFUND chega antes da BET no mesmo grupo FIFO; pendência recebe ack, consumidor reinicia, BET entra e worker real de referências conclui. |
| R18 | Proxy TCP recusa PostgreSQL somente para um consumidor; saldo/inbox não mudam. Restaurar acesso permite a mesma entrega concluir. Suites existentes provam DLQ, redrive e shutdown. |
| R19 | Proxy HTTP devolve 503 a um publisher; evento mantém estado retryable e publica após restore. Dois publishers mantidos na barreira de reserva possuem cabeças distintas. |
| R19 | IPC pausa após envio SQS/pré-confirmação; SIGKILL, expiração real da lease, novo publisher e consumidor de produção drenam eventos. Reentrega com novo dedup ID confirma dedup persistente por eventId. |
| R24 | Reconciliação HTTP de toda wallet do banco com saldo esperado literal; journal por moeda balanceado, pares válidos, receipts/efeitos/eventos completos, projeções atualizadas, nenhuma pendência e filas/DLQs vazias. |

## Coordenação e limites

O roteiro integrado reutiliza `runCommandWorker`, `createSubmission`, o publisher
existente com observers e os entry points de produção de publisher, consumidor de
eventos e worker de referências. Falhas SQL são injetadas na fronteira de schema
aprovada em `docs/testing-strategy.md`. Polling limitado observa estado SQL/IPC e
expiração de lease; não escolhe um sleep para tentar acertar o instante do crash.

A janela FIFO pode suprimir a republicação imediata após crash. Por isso outra
entrega do mesmo evento, com dedup ID novo, passa pelo SQS e é conferida contra a
inbox persistente; não se afirma exactly-once de transporte. LocalStack não é uma
conta AWS. Tempos encurtados são configuração do harness, não SLA de produção.
Não é ensaio de carga nem prova de ganho linear; isso pertence à Issue #13.

## Execução local em 2026-11-13

- `bun run build`: passou, incluindo typecheck e bundle do console.
- `bun test tests/unit`: 35 passaram; zero falhas.
- `bun run test:recovery`: 66 passaram em quatro fases; cerca de 80 s.
- `bun run test:integration`: 104 passaram, um teste de navegador separado,
  zero falhas; 803 assertions, cerca de 92 s. A suíte de navegador existente
  não foi repetida neste recorte, que não altera frontend ou autenticação.
- Cenário integrado: 13 wallets reconciliadas com diferença `0.00`; 27 partidas,
  total pareado `1820.00 BRL` (13 aberturas de 100, quatro BET de 80 e dez
  movimentos de 20), 43 eventIds únicos, 43 inboxes de eventos e 13 projeções.
  Todas as oito verificações de efeitos/eventos/projeções pendentes retornaram zero.
- Controle negativo do runner com endereço PostgreSQL indisponível: exit 1,
  `completed=false`, apenas a primeira fase registrada e evidência anterior limpa.

Asserções financeiras usam valores literais do roteiro e reconciliação pública.
O balanceamento decorre da partida pareada por registro, acrescido da validação
de contas distintas/moedas compatíveis e dos totais esperados; não se apresenta
uma soma artificial de `amount - amount` como prova independente.
Logs completos e JSON por wallet estão nos artifacts locais ignorados pelo Git;
a CI repete o roteiro e publica o JSON integral no log, sem tokens/credenciais.
