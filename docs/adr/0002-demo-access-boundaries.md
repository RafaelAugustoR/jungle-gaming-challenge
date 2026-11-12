# Acesso ao console de demonstração

A entrega terá um ambiente de demonstração sem dinheiro real, com permissões verificadas no backend: viewer consulta wallets, transações, ledger e métricas; operator também executa reconciliação sem corrigir saldo; demo-operator também cria wallets e dispara cenários de demonstração. A identidade de máquina do provedor permanece separada da identidade humana que inicia um cenário.

O README não prescreve papéis nem frontend. Escolhemos permissões explícitas para demonstrar controle de acesso sem conceder movimentação financeira a qualquer usuário autenticado. Demonstração e testes automatizados terão recursos isolados; a interface não constitui uma barreira de segurança.

Referências: [README](https://github.com/junglegaming/backend-challenge), seções 2 e 9; [Stripe roles](https://docs.stripe.com/get-started/account/teams/roles); [Stripe sandboxes](https://docs.stripe.com/sandboxes). Decisão acordada no grill em 2026-11-11.
