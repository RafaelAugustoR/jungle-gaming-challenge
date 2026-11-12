# Publicação da outbox com reservas persistentes

Publishers concorrentes reservarão eventos usando SKIP LOCKED em uma transação SQL curta, com prazo de expiração e identificação da reserva persistidos. A publicação SQS ocorre fora dessa transação; a confirmação de publicação verifica a posse da reserva. Reservas expiradas permitem recuperação por outro publisher.

Uma falha após o envio e antes da confirmação persistida pode causar republicação. O eventId permanece estável e consumidores deduplicam persistentemente. A estratégia garante recuperação sem prometer exactly-once no transporte; a validade de uma reserva não impede, por si só, envio tardio ao broker por um processo antigo.

Falhas transitórias usam backoff e ficam visíveis em métricas. Eventos financeiros confirmados não são descartados após um número de tentativas; falhas permanentes preservam o registro para tratamento operacional. A especificação detalhará expiração, posse, recuperação e política de ordenação por agregado.

Referências: [README](https://github.com/junglegaming/backend-challenge), seção 11; [AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html); [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html). Decisão aprovada no grill em 2026-11-11.
