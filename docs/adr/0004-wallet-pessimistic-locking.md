# Lock pessimista por wallet

O processamento financeiro usará lock pessimista por wallet em transações PostgreSQL curtas, adquirindo o lock antes de avaliar e alterar o saldo. Wallet, transação, ledger, inbox aplicável e outbox serão confirmados atomicamente; publicação e outras chamadas externas ocorrerão fora dessa transação.

Escolhemos essa estratégia pela clareza sob disputa entre múltiplas instâncias, em vez de depender de retries de optimistic locking. Wallets diferentes devem avançar independentemente; constraints complementam as garantias de unicidade e não-negatividade. O custo de espera em wallets disputadas será medido no teste de carga.

O desenho posterior deve definir ordem consistente dos locks, tratamento limitado de falhas transitórias e contas de contrapartida que não introduzam um lock global. Referências: [README](https://github.com/junglegaming/backend-challenge), seção 8; [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html). Decisão aprovada no grill em 2026-11-11.
