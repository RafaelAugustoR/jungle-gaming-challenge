# Prazo de espera por referências

Operações aguardando referência terão TTL configurável de 15 minutos desde a primeira aceitação; reenvios não renovam o prazo. O worker usará backoff exponencial a partir de 1 segundo, limitado a 30 segundos, com jitter. Prazo e próxima tentativa serão persistidos para sobreviver a reinícios.

Ao esgotar o prazo, a operação será rejeitada com REFERENCE_NOT_FOUND quando a referência estiver ausente ou REFERENCE_NOT_READY quando ainda estiver pendente, produzindo o evento correspondente via outbox. Falha de infraestrutura não constitui evidência de ausência: a decisão terminal exige acesso bem-sucedido ao estado persistido. A especificação detalhará a arbitragem entre conclusão da referência e expiração concorrentes.

O TTL é uma escolha do desafio, não um SLA presumido de provedores reais. Testes poderão controlar o relógio e a demonstração poderá configurar prazos menores, preservando o mesmo algoritmo. Um contrato real exigiria ajustar o prazo a atrasos observados e compromissos do provedor.

Referências: [README](https://github.com/junglegaming/backend-challenge), seção 7.1; [AWS backoff and jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/). Decisão aprovada no grill em 2026-11-11.
