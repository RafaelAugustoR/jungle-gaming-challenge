# Issue #7 — consumidor de comandos financeiros

Ambiente: Bun 1.3.14, PostgreSQL 16.6, LocalStack 4.0.3 (SQS FIFO real no emulador),
Keycloak 26.0.7. Banco descartável com migrations e credenciais restritas de runtime;
filas exclusivas por teste. Não usa mocks de banco ou de mensageria.

## Reprodução

```sh
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait postgres sqs keycloak
docker compose run --rm provision
bun run build
bun test tests/unit
INTEGRATION=1 bun test tests/integration/command-consumer.test.ts
bun run test:integration
```

## Evidências por requisito

| Requisito | Cenário em `tests/integration/command-consumer.test.ts` | Resultado observado |
| --- | --- | --- |
| R09 | Mesmo messageId com deduplication IDs de transporte distintos e occurredAt alterado | Duas entregas à aplicação; saldo 80.00, versão 2 e inbox única. |
| R09 | HTTP → SQS, SQS → HTTP, novo messageId para mesma submissão e corrida HTTP/SQS em três processos | Recibo original preservado; uma única aceitação financeira por chave; seis wallets reconciliadas na corrida. |
| R09 | Divergência de messageId, chave e identidade externa | Diagnósticos INBOX_CONFLICT, IDEMPOTENCY_CONFLICT e EXTERNAL_TRANSACTION_CONFLICT na DLQ; inbox original preservada. |
| R16 | Trigger controlada falha na conclusão da inbox | Rollback da aceitação e do débito; redelivery da própria mensagem conclui 80.00, sem reinjetar mensagem. |
| R16 | Fronteira SQL e migration down/up | Commit de inbox incompleta e alteração de associação concluída recusados; constraints reaplicadas. |
| R17 | SIGKILL coordenado por IPC após commit e antes de delete | Outro processo recebe a mesma mensagem após expiração; saldo 80.00, versão 2, inbox única e reconciliação consistente. |
| R18 | DLQ inexistente e recuperação | Origem preservada até envio confirmado; provedor desconhecido não debita. |
| R18 | SIGKILL entre DLQ send e source delete | Origem reentregue; deduplication ID determinístico deixa um diagnóstico na janela FIFO; origem removida após confirmação. |
| R18 | Persistência indisponível por cinco tentativas | Redrive nativo para DLQ, corpo original preservado, sem criar REJECTED/FAILED nem alterar saldo. |
| R18 | SIGTERM sob lock PostgreSQL | Heartbeat impede redelivery durante processamento; após limite de drain cancela query, faz rollback e só então devolve visibilidade. Outro worker conclui. |
| R18 | SIGTERM com operação terminando durante drain | Commit e ack concluídos antes de sair; nenhuma origem reentregue. |
| #6 / entrega 11 | REFUND antes de BET no mesmo grupo FIFO | Pendência recebe ack, BET entra, worker de referências conclui REFUND e saldo retorna a 100.00 reconciliado. |
| Multiprocesso | Três consumidores com barreira IPC e 50 duplicatas extras | 53 entregas, três operações, três wallets em 80.00 e reconciliação consistente. Logs emitem COMMAND_MULTIPROCESS_EVIDENCE com PIDs reais. |
| Bootstrap | Entry point de produção com --once | Processa sem servidor HTTP e fecha conexões. |
| Separação #8 | Suíte de outbox/eventos existente | Consumidor demonstrativo continua independente do consumidor financeiro. |

## TDD

Ciclos observados: módulo ausente → primeiro comando/duplicata; INBOX_CONFLICT
sem encaminhamento → transferência para DLQ; provisionador ausente → filas/redrive;
envelope inválido perdendo messageId → diagnóstico preservado; associação da inbox
alterável → trigger de imutabilidade. Cada ciclo executou o teste falhando antes da
correção, seguido de execução bem-sucedida. Demais cenários ampliam a evidência nas
mesmas interfaces aprovadas em `docs/testing-strategy.md`.

## Limites

SQS é exercitado no LocalStack fixado pelo Compose, não em conta AWS. Deduplicação
FIFO tem janela limitada; a garantia financeira vem da inbox/idempotência SQL.
DLQ não é uma transição financeira. Logs e testes de falha não prometem exactly-once
no transporte. Tempos de teste são encurtados por configuração; coordenação de crash
usa IPC e estado de lock no PostgreSQL, sem sleeps longos para tentar acertar corridas.

## Execução local em 2026-11-13

- `bun run build`: passou (inclui typecheck).
- `bun test tests/unit`: 35 passaram, zero falhas.
- `INTEGRATION=1 bun test tests/integration/command-consumer.test.ts`: 19 passaram,
  zero falhas; 118 assertions, cerca de 25 s.
- `bun run test:integration`: 99 passaram, zero falhas; um teste de navegador
  explicitamente separado; 707 assertions, cerca de 59 s. Inclui toda a suíte da #8.
- Os logs completos ficam em `artifacts/issue-7/` (ignorados pelo Git). A CI repete
  as suítes e preserva o resultado no log do job do PR.

A corrida de 50 submissões HTTP já existente também permaneceu válida na execução
completa: uma aceitação, 49 replays, saldo/reconstrução 20.00, um débito e um evento
WagerTransactionProcessed. Os três processos HTTP tinham PIDs 85826, 85849 e 85878;
o reinício usou 85904. A execução isolada do consumidor registrou PIDs 85453,
85454 e 85455 para os três processos, com 53 entregas e três operações reconciliadas.

Após a [revisão em dois eixos](review.md), a regressão adicional de SQS lento passou:
`commands.log` registra **20 testes, 120 assertions e zero falhas**, cerca de 26 s.
O teste de navegador separado passou (7 assertions) após instalar Chromium em `/tmp`
com `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`, plataforma usada pela CI.

O smoke do Compose construiu a imagem de produção, aplicou migrations num banco
novo `issue7_smoke_20261113`, iniciou o consumidor (`command_worker_started`) e o
encerrou com SIGTERM. O volume local anterior tinha schema inconsistente antes da
migration da #6; foi preservado. O override de smoke apenas apontou migrate e
command-consumer para o banco isolado, sem alterar arquivos versionados.
