# Entrega e diferenciais de apresentação

Escopo aprovado no grill em 2026-11-11.

## Entrega principal

Repositório com execução reproduzível via Docker Compose, configuração de demonstração, usuários por perfil, comandos de testes e roteiro de avaliação. README.md documentará setup e comandos; ARCHITECTURE.md reunirá decisões, trade-offs e limitações.

O ambiente local é a referência de avaliação e não depende da disponibilidade da implantação hospedada. As credenciais de demonstração local não devem ser reutilizadas automaticamente na hospedagem.

## Diferenciais aprovados

- Demonstração hospedada com console e API em HTTPS, autenticação e dados fictícios.
- Banco, filas e interfaces administrativas de infraestrutura sem exposição pública.
- Vídeo curto demonstrando disputa de saldo, replay idempotente e recuperação após falha, acompanhado da reconciliação final.

Destino da hospedagem, custos, credenciais de acesso e forma de disponibilizar o vídeo ainda serão definidos antes da publicação. A aprovação deste escopo não seleciona um serviço pago nem autoriza gastos específicos.

Situação na Issue #14: configuração hospedada reproduzível em [deploy/hosted](../deploy/hosted/README.md), testada localmente com HTTPS; roteiro e gravação em [demo-script.md](demo-script.md). Destino, custo, acesso e canal do vídeo continuam pendentes de decisão, listados em [submission.md](submission.md).

Referências: [README do desafio](https://github.com/junglegaming/backend-challenge), seções 4 e 14. Hospedagem e vídeo são diferenciais escolhidos por nós, não requisitos do README.
