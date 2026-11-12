# Contrato de respostas HTTP

O contrato aprovado usa 201 para wallet criada; 200 para operação processada imediatamente; 202 para aceite pendente; 400 para payload inválido ou chave obrigatória ausente; 401 para token ausente ou inválido; 403 para permissão insuficiente ou identidade de provedor incompatível; 404 para recurso consultado inexistente; 409 para conflito de idempotência ou wallet duplicada; 422 para rejeição de negócio; 503 para indisponibilidade transitória; e 500 para erro inesperado.

Erros carregam código estável, mensagem e correlationId. Rejeições persistidas incluem transactionId e failureCode. Consultar uma transação rejeitada retorna 200 com estado REJECTED; o erro da operação não transforma uma consulta bem-sucedida em falha HTTP.

Replays preservam o status original conforme ADR 0007. Um 503 anterior à confirmação não vira rejeição definitiva persistida; o cliente pode repetir a mesma chave. Se o resultado do commit for incerto, a repetição e as consultas devem resolver o estado sem assumir que houve rollback.

Referências: [README](https://github.com/junglegaming/backend-challenge), seção 9; [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html). Decisão aprovada no grill em 2026-11-11.
