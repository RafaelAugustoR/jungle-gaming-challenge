# Pagamentos externos como extensão posterior

O desafio avalia processamento de apostas e permite criar wallets com saldo inicial; não exige integração de depósitos ou saques. A entrega principal incluirá os diferenciais acordados de partidas dobradas, teste de carga e painel, enquanto a integração com um sandbox de pagamentos fica como extensão posterior, sem bloquear a conclusão.

Essa fronteira preserva o prazo e evita introduzir confirmação de pagamentos e conciliação externa no núcleo de apostas. Caso a extensão seja implementada, deverá representar depósitos como operações próprias, sem reutilizar artificialmente WIN ou OPENING, e usar apenas dinheiro de teste.

Referência: [README do desafio](https://github.com/junglegaming/backend-challenge), seções 9 e 14. Decisão acordada no grill em 2026-11-11.
