# Ledger de partidas dobradas

A wallet representa o valor devido ao jogador. Cada movimentação financeira produzirá uma partida na conta do jogador e outra de igual valor e direção oposta em uma conta de contrapartida, na mesma moeda e na mesma transação SQL. A consulta de ledger da wallet expõe apenas sua partida, preservando o limite de um lançamento por transação financeira por wallet.

Contrapartidas de abertura e de operações de jogos serão distintas. A abertura representa saldo inicial de demonstração, não confirmação de depósito bancário. BET debita a conta do jogador e credita a contrapartida de jogos; REFUND faz o inverso. LOSS e operações rejeitadas não geram partidas.

Os totais das contrapartidas serão derivados dos lançamentos, sem atualizar um saldo global a cada aposta, evitando um ponto de serialização entre wallets independentes. A especificação definirá as constraints que garantem balanceamento e imutabilidade no banco, além da consistência com o saldo materializado da wallet.

Referências: [README](https://github.com/junglegaming/backend-challenge), seção 6.4; [TigerBeetle financial accounting](https://docs.tigerbeetle.com/coding/financial-accounting/). Decisão aprovada no grill em 2026-11-11.
