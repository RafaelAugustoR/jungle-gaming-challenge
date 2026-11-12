# Referências para permissões e demonstração

Pesquisa em 2026-11-11. As propostas abaixo ainda dependem da decisão no grill.

## Base do desafio

[README](https://github.com/junglegaming/backend-challenge): seção 2 permite autenticação com IdP externo e mantém health público; seção 9 exige criação de wallet, submissão, consultas e reconciliação sem correção silenciosa; seção 10 exige o mesmo caso de uso para HTTP e SQS. Frontend, perfis humanos e isolamento de demonstração não são prescritos.

## Evidências e limites

- [Stripe: roles](https://docs.stripe.com/get-started/account/teams/roles): permissões humanas são diferenciadas; certos perfis podem realizar ações financeiras. Não sustenta proibir universalmente operações financeiras humanas.
- [Stripe: sandboxes](https://docs.stripe.com/sandboxes): testes isolam dados e acesso da operação live; desenvolvimento e CI devem usar sandboxes separados. Sustenta isolamento real, não apenas uma aba visual.
- [Keycloak: JavaScript adapter](https://www.keycloak.org/securing-apps/javascript-adapter): aplicações no navegador usam cliente público, sem segredo de cliente, com redirect URIs e origens restritas.
- [AWS: transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html): persistência e notificação exigem tratamento da falha de dual write; publicação pode duplicar, exigindo consumidores idempotentes.
- [TigerBeetle: correcting transfers](https://docs.tigerbeetle.com/coding/recipes/correcting-transfers/): correções acrescentam transferências, preservando o histórico imutável. Referência conceitual; não propõe trocar PostgreSQL nem alterar as regras de reversão do desafio.

## Proposta para discussão

Entregar um ambiente de demonstração, sem integração com dinheiro real. Separar recursos de demonstração dos testes automatizados: banco, filas e credenciais próprios por ambiente. Usar o mesmo código financeiro em todos eles.

Console: viewer consulta; operator consulta e reconcilia. Um papel adicional demo-operator pode executar cenários exclusivamente na implantação de demonstração. Esses papéis são decisões nossas, não exigências do README.

Operações de provedores usam identidade de máquina vinculada ao providerId. Se o console disparar simulações via backend, credenciais de máquina permanecem no servidor, e a auditoria distingue usuário iniciador e provedor simulado. Nenhum providerId arbitrário do navegador concede autoridade.

Não construir uma plataforma de provisionamento de sandboxes nem um ambiente financeiro live para este desafio. O isolamento proposto é por implantação/configuração, evitando acrescentar tenancy ao modelo financeiro.
