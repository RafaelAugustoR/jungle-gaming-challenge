# Operação e diagnóstico

Procedimentos para os workers, as filas e a outbox. Métricas, dashboard e health checks estão em
[observability.md](observability.md). As decisões estão nas ADRs 0011, 0013 e 0014. Os comandos
supõem o `.env` local ou o Compose deste repositório.

## Referências pendentes (`reference-worker`)

REFUND e ROLLBACK exigem uma referência. WIN e LOSS podem informar uma referência a uma BET. Quando
a referência ainda não existe ou está pendente, o aceite retorna `202 PENDING_REFERENCE` e o saldo
não se move. O worker reavalia a operação com backoff exponencial: base `REFERENCE_BASE_MS` (1 s),
teto `REFERENCE_MAX_MS` (30 s) e jitter de 50–100%. O prazo é `REFERENCE_TTL_MS` (15 min), fixado
no primeiro aceite. Replays não estendem esse prazo. Agenda, tentativas e deadline ficam em
`wagering.reference_retries`, e o processo não guarda estado em memória.

Quando o prazo vence:

- Referência ausente gera `REFERENCE_NOT_FOUND`.
- Referência ainda pendente ou processada depois do prazo gera `REFERENCE_NOT_READY`.
- Referência rejeitada ou com falha gera `REFERENCE_NOT_PROCESSED`, sem esperar o TTL.

Uma falha de infraestrutura não prova que a referência não existe. Nesse caso a pendência é adiada
e o deadline original continua valendo. O worker obtém o mesmo lock de wallet usado pelas
submissões, então vários processos podem rodar ao mesmo tempo com segurança.

Consulta SQL (somente leitura):

```sql
select t.id, t.kind, t.status, r.deadline, r.next_attempt_at, r.attempts
from wagering.transactions t join wagering.reference_retries r on r.transaction_id = t.id
where t.status = 'PENDING_REFERENCE' order by r.next_attempt_at;
```

## Comandos SQS (`command-consumer`)

- Inbox `messaging.command_inbox`, com chave `(consumer_name, message_id)` e hash canônico do
  comando + chave. Inbox, recibo, saldo, partidas e outbox entram na mesma transação SQL. O
  `DeleteMessage` acontece somente depois do commit.
- Rejeições de negócio e `PENDING_REFERENCE` são persistidas e recebem ack.
- Falhas transitórias não recebem ack e entram em backoff, com base de 1 s e teto de 30 s.
- O redrive nativo envia a mensagem à DLQ depois de `COMMAND_MAX_RECEIVE_COUNT` (5) recebimentos,
  com o corpo original. Uma falha transitória esgotada **não** vira REJECTED nem FAILED.
- Mensagens inválidas e conflitos de contrato (`INBOX_CONFLICT`, `IDEMPOTENCY_CONFLICT`,
  `EXTERNAL_TRANSACTION_CONFLICT`) são enviados à DLQ com o diagnóstico `originalMessageId`,
  `transportMessageId`, `reason` e `originalBody`. A origem só é removida depois que o envio é
  confirmado. Os logs não incluem o corpo.
- A visibilidade é de 30 s e é renovada a cada terço desse prazo.
- No SIGTERM, o consumidor para de receber e drena por até `COMMAND_DRAIN_MS` (20 s). Depois cancela
  a query, espera o rollback e devolve a visibilidade. O Compose concede 30 s para o encerramento.

Para tratar a DLQ:

1. Agrupe os diagnósticos por `transportMessageId` e investigue a causa pelos logs, usando o
   `messageId`.
2. Corrija a causa.
3. Reenvie o corpo de negócio original com `MessageGroupId = walletId` e um **novo**
   deduplication ID de transporte. Preserve o `messageId` e a chave quando o conteúdo for o mesmo.
4. Confirme o envio e só então apague a cópia da DLQ.

Um conteúdo corrigido é uma nova mensagem. Chaves já aceitas continuam protegidas contra
divergência, e estados terminais nunca são reabertos.

```sh
bun run provision:commands          # cria as filas/DLQ (idempotente)
bun run worker:commands --once      # uma iteração de receive/processamento
```

## Outbox (`outbox-publisher`)

A API grava os eventos na outbox junto do commit financeiro. O publisher reserva somente o primeiro
evento ainda não publicado de cada wallet, usando `FOR UPDATE SKIP LOCKED`, uma lease de 30 s e um
token de posse. Ele envia o evento para `wager-events.fifo` com `MessageGroupId = walletId` e
deduplication ID = `eventId`. A publicação só é confirmada se o publisher ainda detiver a lease.

Falhas transitórias agendam `next_attempt_at`, com base de 1 s e teto de 60 s. Erros de
credencial ou configuração colocam o publisher inteiro em backoff. Uma rejeição específica de
conteúdo (`InvalidMessageContents`) ou um tamanho acima do `MaximumMessageSize` da fila bloqueia
somente aquele evento, marcando `blocked_at`. A cabeça bloqueada segura os eventos seguintes **da
mesma wallet**; as outras wallets continuam.

```sql
select event_id, aggregate_id, sequence, attempts, lease_until,
       next_attempt_at, blocked_at, last_error_code
from wagering.outbox where published_at is null
order by occurred_at, sequence;
```

Para corrigir a causa e reativar o evento sem alterar o payload:

```sh
bun run outbox:retry <eventId>
```

Nunca marque uma publicação manualmente nem edite o evento financeiro. Republicações são esperadas:
o `eventId` é estável e o consumidor deduplica pela inbox persistente
(`demo_consumer.event_inbox`). A projeção não regride com um evento atrasado. O provisionamento cria
também `wager-events-dlq.fifo` (redrive após 5 recebimentos, retenção de 14 dias). Não há expurgo
automático da inbox nem da outbox.

O limite conhecido de vazão está descrito em [ARCHITECTURE.md](../ARCHITECTURE.md#limitações-conhecidas)
e na [issue #27](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/27).

## Indisponibilidade de dependências

- PostgreSQL ou SQS fora do ar: `/health/ready` responde 503 e indica a dependência. `/health/live`
  continua 200.
- Submissões que não chegam ao commit retornam 503 `INFRASTRUCTURE_UNAVAILABLE` e **não** consomem
  a chave. Repita com a mesma chave. Se o resultado do commit for incerto, consulte a transação ou
  repita a chave; nunca troque a chave.
- Os workers retomam sozinhos, com backoff, quando a dependência volta.
