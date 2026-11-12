# Representação monetária exata

Money será imutável, independente do NestJS e do ORM, usando decimal.js no domínio e NUMERIC com moeda em coluna separada no PostgreSQL. Entrada, saída e conversões de persistência usarão strings, sem conversão monetária para Number. Precisão, limites e constraints serão explicitados na implementação e na especificação.

A entrega operará inicialmente em BRL, preservando moeda no modelo e testes de incompatibilidade entre moedas. Entradas com mais de duas casas serão rejeitadas, sem arredondamento silencioso; a coerção de escala do PostgreSQL não substitui validação. Preferimos decimal.js a centavos em bigint pela proximidade com os contratos decimais e o modelo de referência do desafio.

Referências: [README](https://github.com/junglegaming/backend-challenge), seções 5 e 6.1; [PostgreSQL numeric](https://www.postgresql.org/docs/current/datatype-numeric.html); [decimal.js](https://mikemcl.github.io/decimal.js/). Decisão aprovada no grill em 2026-11-11.
