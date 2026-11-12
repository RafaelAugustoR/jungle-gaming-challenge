# Replay preserva o recibo original da submissão

Uma repetição idêntica do POST retorna o status HTTP e o corpo originais da submissão aceita, alterando apenas idempotentReplay para true. O recibo será persistido e não será recalculado a partir do saldo atual da wallet.

Se a submissão recebeu 202 com PENDING_REFERENCE e depois foi processada pelo worker, seu replay continua retornando o aceite original; os endpoints GET mostram o estado atual da operação. Para processamento imediato, o recibo preserva o saldo observado naquela execução. O frontend acompanha operações pendentes por consulta.

Essa escolha interpreta literalmente a exigência de mesma resposta do README e separa recibo de submissão de estado atual, em vez de alterar a resposta conforme o processamento avança. A política para erros anteriores à aceitação e falhas transitórias será especificada separadamente; esta decisão não exige armazenar toda resposta HTTP de erro.

Referências: [README](https://github.com/junglegaming/backend-challenge), seções 7 e 9; [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests). Decisão aprovada no grill em 2026-11-11.
