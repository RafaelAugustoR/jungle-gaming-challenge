# Resultado do grill

Decisões acordadas em 2026-11-11. A etapa de entrevista está concluída para elaboração da especificação; isso não significa que implementação ou validação tenham sido realizadas.

## Documentação

- Vocabulário: ../CONTEXT.md.
- Decisões: adr/0001 a adr/0017.
- Estrutura: project-structure.md.
- Testes: testing-strategy.md.
- Carga: load-testing.md.
- Observabilidade: observability.md.
- Entrega: delivery.md.
- Referências de acesso e demonstração: research/operational-boundaries.md.

## Direção aprovada

Monólito modular com MikroORM, API e workers em processos separados, transação financeira única no PostgreSQL e lock por wallet. Money decimal exato, BRL inicial, ledger de partidas dobradas, inbox/outbox persistentes e regras explícitas de idempotência, replay e referências fora de ordem.

Keycloak protege identidades humanas e provedores. O console de demonstração usa os perfis viewer, operator e demo-operator. Testes incluem infraestrutura real, múltiplos processos, falhas controladas, navegador e carga. Prometheus/Grafana, demonstração hospedada e vídeo complementam a entrega reproduzível em Compose.

Pagamentos externos e OpenTelemetry permanecem extensões posteriores, conforme decisões registradas.

## Especificação a produzir

Converter cada requisito do README em critérios de aceite e evidências, distinguindo exigências, interpretações aprovadas e diferenciais. Incluir contratos, schema e invariantes no banco, módulos, interfaces de testes e plano de implementação em entregas verticais.

Detalhar parâmetros e lacunas sem tratá-los como decisões já aprovadas: limites monetários e valores zero, hash canônico, constraints das partidas, ordem de aquisição de locks, ordenação de eventos, prazos de reserva e visibilidade, expiração concorrente de referências, transferência segura para DLQ e políticas de falha permanente. Qualquer contradição relevante com as decisões aprovadas deve ser trazida ao usuário.

Destino e custos da hospedagem, acesso à demonstração e publicação do vídeo ainda precisam ser definidos antes do deploy.

AGENTS.md permanece preservado conforme instrução inicial do usuário.
