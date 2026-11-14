# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

O console é Preact com TSX (`frontend/src/`), empacotado pelo próprio Bun (`scripts/build-frontend.ts` gera `frontend/dist`, com as fontes self-hosted em `frontend/fonts/`). A API NestJS serve os arquivos na porta 3000, sem servidor de frontend separado. Bun 1.3.14 roda o build e os testes.

Escolha do usuário no redesign (sem Vite). Mudanças de stack exigem atualizar quatro pontos:

- `scripts/build-frontend.ts`;
- o `Dockerfile`;
- o teste de navegador `tests/integration/console.test.ts` (`bun run test:browser`);
- o gravador do vídeo `scripts/record-demo.ts`, na branch `feat/issue-14-delivery`.

## Users

O usuário principal é o **avaliador do desafio de backend da Jungle Gaming**. Ele usa o console de três formas:

- ao vivo no ambiente local, com Docker Compose;
- na demonstração hospedada em HTTPS;
- assistindo ao vídeo curto de demonstração.

O trabalho dele é verificar, em poucos minutos, que o processador de apostas cumpre as garantias financeiras exigidas. O console não se destina a operadores reais de apostas nem a jogadores.

## Product Purpose

O console é uma ferramenta de **prova**. Ele permite que o avaliador crie uma wallet fictícia, dispare cenários reais contra a API usada pelos provedores e veja, com dados daquela execução, as garantias do sistema:

- nenhum débito duplicado: replay idempotente com a mesma chave;
- saldo nunca negativo: disputa concorrente pelo saldo;
- referências fora de ordem resolvidas: REFUND antes da BET;
- recuperação depois de falha de processos;
- ledger que reconstrói o saldo: reconciliação.

Sucesso significa que o avaliador entende o que cada cenário prova e vê a evidência, sem ler logs nem deduzir a partir de campos crus.

## Positioning

A prova não é simulada. Os cenários passam pelo mesmo endpoint HTTP e pelo mesmo token de máquina dos provedores. O ledger é real e imutável, por partidas dobradas. O console mostra lado a lado o **recibo original imutável** e o **estado atual** de cada transação, e a reconciliação reconstrói o saldo a partir do journal.

## Operating Context

- **Login:** Keycloak com Authorization Code + PKCE. Os tokens ficam em memória.
- **Perfis:**
  - `viewer` consulta;
  - `operator` também reconcilia;
  - `demo-operator` também cria wallets e roda cenários.
  - As restrições valem no backend, não só nos botões.
- **Cenários disponíveis:**
  - `duplicate`: replay idempotente;
  - `race`: duas BETs de 80% do saldo em paralelo;
  - `out-of-order`: REFUND antes da BET referenciada.
- **Estados pendentes** (`PENDING_REFERENCE`) são acompanhados por GET até o estado terminal.
- **Vídeo:** um roteiro (`docs/demo-script.md` na branch da issue 14) derruba workers com `docker compose kill` e mostra a recuperação no console. O vídeo será regravado, com narração, depois do redesign.
- **Observabilidade complementar:** Prometheus e Grafana na porta 3001.

## Capabilities and Constraints

- Os valores monetários chegam como strings decimais com duas casas e precisam ser exibidos sem perder precisão. Não converter para float.
- Os tipos de operação são OPENING, BET, WIN, LOSS, REFUND e ROLLBACK.
- Os estados são PENDING, PENDING_REFERENCE, PROCESSED, REJECTED e FAILED.
- Os erros da API trazem `code`, `message` e `correlationId`.
- A listagem de transações é paginada com cursor, aceita filtros `walletId`, `status`, `kind` e `providerId`, e retorna no máximo 100 por página.
- O ledger também é paginado com cursor.
- Todos os dados da demonstração são fictícios. Não exibir credenciais de máquina no navegador.
- Os textos da interface são em pt-BR.
- **Nome do produto:** **Lastro**. O console se chama "Lastro · Console de prova" e substitui "Jungle Console". O nome não usa a marca Jungle Gaming.

## Brand Commitments

- O produto deve ter a identidade de **iGaming / casa de aposta**, coerente com o domínio do desafio. O usuário pediu isso explicitamente.
- **Não** usar o nome, o logo, as cores ou outros elementos de marca da Jungle Gaming ou de qualquer casa de aposta real. O produto tem identidade própria.

## Evidence on Hand

- Dados reais de execução: `docs/evidence/issue-14/demo-run.json` e as evidências por issue em `docs/evidence/`.
- Provas automatizadas: `bun run test:concurrency`, `test:recovery` e `test:load`. Os relatórios estão em `docs/evidence/` e `docs/load-testing.md`.
- Crítica de design de 2026-11-14 (nota 19/40): `.impeccable/critique/`.
- Não existem depoimentos, clientes ou métricas de produção. Não inventar nada disso.

## Product Principles

1. **Veredito antes de dado.** Cada cenário diz o que deveria acontecer, o que aconteceu e se a garantia se manteve. Os campos crus ficam disponíveis como evidência, não como mensagem principal.
2. **A evidência é da execução.** Só exibir o que veio da API naquela execução. Nada fica fingido nem pré-calculado no front.
3. **Imutável e atual nunca se confundem.** O recibo original e o estado atual são visualmente distintos, e o que mudou entre eles fica evidente.
4. **O resultado aparece onde a ação aconteceu.** O feedback de um cenário fica visível sem procurar, tanto ao vivo quanto no vídeo.
5. **Tudo gira em torno de uma wallet.** O fluxo do avaliador é criar ou selecionar uma wallet, provar, conferir o ledger e reconciliar.

## Accessibility & Inclusion

O mínimo é WCAG 2.2 AA:

- fluxo completo pelo teclado;
- foco visível;
- status anunciados em live regions;
- status que não dependem só de cor;
- `prefers-reduced-motion` respeitado. O console atual já cumpre esse item e os de foco visível e live regions; o redesign deve manter.
