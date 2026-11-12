# Revisão da Issue #4

Base fixa: main `51afc7587fce1701e512942cbb4d0cc06acaa73b` (PR #16). Revisão pelo skill code-review após implementação/TDD, com eixos Standards e Spec em agentes paralelos e verificação incremental das correções.

## Standards

Sem violações objetivas de padrões documentados. Domínio sem NestJS/ORM, SQL no adaptador, transação financeira única, interfaces de teste aprovadas e infraestrutura real.

Duas sugestões P3 foram tratadas:

- `WageringSession.save` recebia journal e evento como opcionais independentes. Agora `movement?: { entry, balanceEvent }` exige o conjunto completo, seguindo o padrão de `WalletOpening` da #3.
- Classificação transitória PostgreSQL duplicada entre wallet/wagering. Agora é compartilhada em `src/shared/infrastructure/postgres-error.ts`, preservando o tratamento específico de constraints por módulo.

Revisão incremental confirmou ambas resolvidas e nenhum novo bloqueador/violação documentada.

## Spec

Um achado P2 foi reproduzido e corrigido:

- Spec: “Deadlock/timeout recebe retry limitado, até três tentativas por chamada, respeitando o prazo total.” O código `57014` era transitório, mas não participava do retry. Agora statement_timeout participa do retry de transação inteira. Um trigger/sequência em PostgreSQL real cancela somente a primeira tentativa; o teste observou 503 antes e 200 depois, exatamente duas tentativas, um débito e wallet 80.00/versão 2.

Revisão incremental confirmou a resolução. Autenticação/ownership, hash, escopo, conflitos pós-rollback, recibos históricos, atomicidade, zero/versão, terminais e três processos foram avaliados sem outros achados no recorte BET.

**Final: Standards — 0 violações / 0 sugestões pendentes; Spec — 0 achados pendentes.**
