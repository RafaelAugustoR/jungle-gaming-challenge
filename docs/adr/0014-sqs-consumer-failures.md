# Tratamento de falhas no consumidor SQS

Operações processadas ou rejeitadas por negócio serão confirmadas na fila somente após persistência do resultado, inbox e eventos aplicáveis. Operações PENDING_REFERENCE também serão confirmadas após persistência: o worker agendado assume seu acompanhamento, liberando o grupo FIFO para receber a referência ausente.

Falhas transitórias não recebem ack e usam novas tentativas com backoff e jitter. O maxReceiveCount inicial será 5, configurável, antes do redrive para DLQ. Mensagens permanentemente inválidas não executam negócio e são encaminhadas à DLQ com diagnóstico; a especificação detalhará a transferência segura, sem remover a origem antes da confirmação de destino, e a deduplicação necessária em caso de falha intermediária.

Em SIGTERM, o consumidor para de receber, aguarda operações em andamento por prazo limitado e libera mensagens não concluídas após interromper seu processamento. Reinícios e redelivery continuam sujeitos à inbox e à idempotência persistente. Timeouts serão definidos na especificação e verificados com testes de falha.

Referências: [README](https://github.com/junglegaming/backend-challenge), seção 10; [AWS DLQ](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html); [AWS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html). Decisão aprovada no grill em 2026-11-11.
