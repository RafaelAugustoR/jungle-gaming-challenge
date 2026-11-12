# Monólito modular com MikroORM

O backend será um monólito modular NestJS em Bun, usando MikroORM e PostgreSQL como fronteira transacional. API HTTP, consumidor SQS, publisher da outbox e worker de referências serão processos executáveis separadamente, compartilhando o núcleo financeiro e uma mesma imagem de backend com seleção de processo na inicialização.

Cada requisição ou trabalho terá contexto de persistência isolado. O domínio permanece independente de NestJS, SQS e ORM; adaptadores implementam integrações. Essa organização permite escalar e reiniciar processos sem distribuir a transação financeira entre serviços e bancos distintos.

A estrutura de pastas será adaptada à referência fornecida pelo usuário, preservando vocabulário familiar de controllers, DTOs, consumers, producers, repositories e configuração. A árvore exata ainda será discutida; a organização visual não deve introduzir dependências de infraestrutura no domínio.

Referências: [README](https://github.com/junglegaming/backend-challenge), seções 4, 10 e 11; [MikroORM identity map](https://mikro-orm.io/docs/identity-map). Decisão aprovada no grill em 2026-11-11.
