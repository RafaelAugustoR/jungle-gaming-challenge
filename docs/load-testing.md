# Experimento de carga

Plano aprovado no grill em 2026-11-11. A execução será disponibilizada como bun run test:load, usando Bun e mantendo a infraestrutura real do desafio.

## Cenários

Comparar uma e três instâncias da aplicação em cada cenário:

1. Muitas operações na mesma wallet: contenção, espera por lock e correção do saldo.
2. Operações distribuídas entre wallets: processamento paralelo.
3. Reenvios duplicados durante a carga: custo da deduplicação e ausência de efeitos financeiros repetidos.

## Metodologia e evidências

- Aquecimento, duração e carga configuráveis, dados reproduzíveis e reconciliação final.
- Registrar ambiente, versões, recursos, distribuição da carga entre instâncias e limites de conexões.
- Informar carga oferecida e efetivamente processada, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag.
- Separar rejeições esperadas de negócio de erros técnicos; contar replays separadamente de operações financeiras únicas.
- Registrar atrasos, requisições não emitidas e limitações do gerador, evitando ocultar saturação quando respostas lentas reduzem a taxa de envio.
- Verificar que o saldo final corresponde ao ledger e que partidas permanecem balanceadas.
- Não presumir ganho linear com três instâncias nem inventar meta de RPS. Documentar gargalos e limites observados.

Referências: [README](https://github.com/junglegaming/backend-challenge), diferencial de carga da seção 14; [k6 open and closed models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/), como referência metodológica, sem substituir o runtime exigido.
