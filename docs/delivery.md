# Entrega e diferenciais de apresentação

Escopo aprovado no grill em 2026-11-11.

## Entrega principal

Repositório com execução reproduzível via Docker Compose, configuração de demonstração, usuários por perfil, comandos de testes e roteiro de avaliação. README.md documentará setup e comandos; ARCHITECTURE.md reunirá decisões, trade-offs e limitações.

O ambiente local é a referência de avaliação e não depende da disponibilidade da implantação hospedada. As credenciais de demonstração local não devem ser reutilizadas automaticamente na hospedagem.

## Diferenciais aprovados

- Demonstração hospedada com console e API em HTTPS, autenticação e dados fictícios.
- Banco, filas e interfaces administrativas de infraestrutura sem exposição pública.
- Vídeo curto demonstrando disputa de saldo, replay idempotente e recuperação após falha, acompanhado da reconciliação final.

Publicação autorizada em 2026-11-14 na VPS já existente, com o Traefik do servidor e dois
hostnames sslip.io escolhidos pelo autor. Nenhum serviço pago novo foi contratado.
Credenciais da demo são geradas e permanecem fora do repositório.

Situação na Issue #14: [demo pública](https://jungle.178-18-253-17.sslip.io), com
[evidência de HTTPS, login e reconciliação](evidence/issue-14/public-deployment.md).
Configuração reproduzível em [deploy/hosted](../deploy/hosted/README.md); roteiro e
gravação em [demo-script.md](demo-script.md). Acesso ao repositório, distribuição das
senhas, canal do vídeo e submissão continuam listados em [submission.md](submission.md).

Referências: [README do desafio](https://github.com/junglegaming/backend-challenge), seções 4 e 14. Hospedagem e vídeo são diferenciais escolhidos por nós, não requisitos do README.
