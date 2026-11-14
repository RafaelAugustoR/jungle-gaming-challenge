# Publicação da outbox com reservas persistentes

Publishers concorrentes reservarão eventos usando SKIP LOCKED em uma transação SQL curta, com prazo de expiração e identificação da reserva persistidos. A publicação SQS ocorre fora dessa transação; a confirmação de publicação verifica a posse da reserva. Reservas expiradas permitem recuperação por outro publisher.

Uma falha após o envio e antes da confirmação persistida pode causar republicação. O eventId permanece estável e consumidores deduplicam persistentemente. A estratégia garante recuperação sem prometer exactly-once no transporte; a validade de uma reserva não impede, por si só, envio tardio ao broker por um processo antigo.

Falhas transitórias usam backoff e ficam visíveis em métricas. Eventos financeiros confirmados não são descartados após um número de tentativas; falhas permanentes preservam o registro para tratamento operacional. A especificação detalhará expiração, posse, recuperação e política de ordenação por agregado.

Referências: [README](https://github.com/junglegaming/backend-challenge), seção 11; [AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html); [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html). Decisão aprovada no grill em 2026-11-11.

## Atualização 2026-11-14 — vazão por agregado (issue #27)

A reserva continua pegando **uma cabeça por agregado** por ciclo; não serão reservadas cadeias de eventos por wallet nesta entrega. A ordem por agregado, as leases e a deduplicação por `eventId` não mudam.

Medições que sustentam a decisão ([evidência](../evidence/issue-27/README.md)):

- O limite observado na carga da #13 não era a política de reserva, e sim o custo da consulta: o teste "existe evento anterior não publicado no agregado?" filtrava o histórico publicado linha a linha (3,3 s por reserva com 3 000 pendentes e 3 000 publicados numa wallet). Um índice parcial `(aggregate_id, sequence) where published_at is null` reduz a reserva para ~10 ms sem alterar semântica. Com histórico publicado grande, o planner também usa esse índice na varredura externa, que deixa de passar pelos publicados. O índice `outbox_publishable` foi removido: nenhuma consulta o usava nos formatos medidos (backlog numa wallet, espalhado por muitas wallets e em backoff de retry), e ele custava uma entrada a mais em todo insert financeiro.
- Com o índice e o laço sem pausa após iterações produtivas (#28), uma wallet publica ~96 eventos/s neste ambiente. Como cada operação processada gera dois eventos, isso sustenta ~48 ops/s numa única wallet; cenários distribuídos drenam em ~0,1 s após a carga, sem custo mensurável no caminho financeiro.

Revisitar se uma única wallet precisar sustentar acima de ~48 ops/s, ou se o atraso de publicação por wallet virar requisito. Antes de mudar a política de reserva:

1. Medir como o ciclo de publicação se divide entre reserva, envio ao SQS e confirmação. A reserva ainda avalia todos os pendentes de cada wallet para encontrar a cabeça (~10 ms com 3 000 pendentes, quase o ciclo inteiro a ~96 eventos/s), então provavelmente continua sendo o limite da wallet quente.
2. Se for a reserva, o passo mais barato é selecionar a cabeça por agregado (o menor `sequence` não publicado de cada wallet), com custo por wallet e não por evento, sem mudar esta decisão.
3. Só depois considerar reservar cadeias contíguas por agregado, com publicação sequencial no mesmo `MessageGroupId`. Nesse caso, definir antes: lease cobrindo a cadeia, expiração no meio da cadeia, envio parcial e republicação.

`scripts/explain-outbox-claim.ts` reproduz o plano da reserva em backlogs configuráveis para essa investigação. Não há expurgo do outbox; a retenção do histórico publicado continua fora desta entrega.
