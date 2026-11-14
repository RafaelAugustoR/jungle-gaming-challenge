# Issue #14 — entrega reproduzível, revisão final, demo hospedada e vídeo

Requisitos: R25 e D05 da [spec](../../spec.md). A rastreabilidade completa está na
[matriz](../../requirements-matrix.md).

## Reprodução a partir de checkout limpo

Ambiente: AMD Ryzen 7 7700 (16 threads lógicas), WSL2 Linux 6.6.87 com 23 GiB, Docker 29.4.3,
Compose 5.1.3 e Bun 1.3.14. A validação usou um `git clone` novo do branch (árvore idêntica ao
commit final, exceto o workflow de CI, que não muda nenhum comando executado), em 2026-11-14.

Isolamento: o projeto Compose foi `jungle-issue14`, com as portas 3010 (API), 55449 (PostgreSQL),
4576 (SQS), 18090 (Keycloak), 9100 (Prometheus) e 3011 (Grafana), e a sub-rede de métricas
`172.31.24.0/24`. A remarcação foi feita por um override fora do repositório e por um `.env` com
essas portas. Nenhum stack de outra sessão foi parado, reiniciado ou apagado.

| Passo (comando documentado no README)                         | Resultado                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                               | ok                                                                                          |
| `bun run typecheck` · `bun run build`                         | ok                                                                                          |
| `bun test`                                                    | 68 pass, 127 skip (precisam de containers), 0 fail                                          |
| `docker compose --profile events up -d --build` + health      | ok; `/health/ready` `{"postgres":true,"sqs":true}`                                          |
| `bun run migrate:down` → `migrate:up` → `migrate:up`          | ok (idempotente)                                                                            |
| `bun run test:integration`                                    | 132 pass, 1 skip (navegador, executado à parte), 0 fail, 948 asserções, 135 s               |
| `bun run test:browser` (`CHROME_PATH=/usr/bin/google-chrome`) | 1 pass, 21 asserções                                                                        |
| `bun run test:recovery`                                       | 4 fases concluídas (`completed: true`), 108 s                                               |
| `docker compose --profile test run --build --rm tests`        | 175 pass, 20 skip, 0 fail                                                                   |
| `STACK_URL=… bun run test:stack` (API do Compose)             | 1 pass, 14 asserções                                                                        |
| `bun run test:load` curto (hot-wallet, 20 ops/s, 5 s, 1 API)  | `invariants=ok`, 0 erros. Só valida o comando; o benchmark completo da #13 não foi repetido |

Notas:

- `bunx playwright install chromium` não suporta este host (Ubuntu 26.04), então o teste de
  navegador usou o Chrome do sistema pela alternativa documentada `CHROME_PATH`. A CI instala o
  Chromium normalmente.
- O benchmark de carga **não** foi repetido. As mudanças desta issue não tocam o caminho financeiro
  nem a outbox. As evidências da [#13](../issue-13/README.md) continuam válidas (12/12 combinações
  com invariantes ok).
- A mesma sequência executada contra o `origin/main` (`1f8f0e4`) também passou em todos os passos.
  Esse stack não tinha `test:stack`; a falha descrita a seguir foi reproduzida manualmente nele.

### Defeito encontrado e corrigido

No `origin/main`, `POST /demo/scenarios` na API **do Compose** retornava
`503 INFRASTRUCTURE_UNAVAILABLE` para todo cenário. A API obtinha o token do provedor pela URL
interna (`http://keycloak:8080`), e o Keycloak em modo dinâmico emitia `iss=http://keycloak:8080/…`,
diferente do `KEYCLOAK_ISSUER` público que a API valida. A CI não detectava o problema porque o teste
de navegador sobe a própria API em processo, com as URLs do host.

A correção ficou no `compose.yaml`: `KC_HOSTNAME` fixo e `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`,
com o Keycloak escutando em 18080 também dentro da rede. O container `tests` passou a compartilhar o
namespace de rede do Keycloak para resolver o issuer público. A regressão é coberta por
`tests/stack/demo-stack.test.ts` (`bun run test:stack`), que roda contra qualquer stack em execução.

A CI executa esse smoke contra a API do Compose (`STACK_URL=http://localhost:3000 bun run
test:stack`, com `reference-worker` no `up`). Dessa forma, o defeito não volta sem aviso, mesmo que
o teste de navegador continue usando uma API em processo.

## Revisão final

- **Falhas eliminatórias e restrições do §5:** foram conferidas no código, no schema e nos testes;
  nenhuma está presente. A tabela, com o lugar de cada verificação, está na
  [matriz](../../requirements-matrix.md#falhas-eliminatórias-14).
- **Revisão independente:** um revisor sem acesso às conclusões desta sessão leu o código contra o
  README original, a spec e as ADRs. Não encontrou bloqueios. Os achados foram tratados assim:
  - _Should-fix:_ os testes **unitários** do §13 não cobriam REFUND/ROLLBACK bem-sucedidos nem
    `REVERSAL_INSUFFICIENT_FUNDS`, que só existiam em integração. Foram acrescentados em
    `tests/unit/settlement.test.ts`, cobrindo REFUND→BET, ROLLBACK→BET, ROLLBACK→WIN e
    ROLLBACK→REFUND, com saldo, versão e direção do evento, além da rejeição sem efeito.
  - _Menores:_ a forma do `IntegrationEvent` difere do esqueleto (o envelope serializado é idêntico)
    e a matriz de tipos de referência é validada apenas no domínio. Os dois pontos ficaram
    documentados em [ARCHITECTURE.md](../../../ARCHITECTURE.md#desvios-de-forma-em-relação-aos-esqueletos-do-readme),
    sem refatoração.
- **Documentação:** README e ARCHITECTURE foram reescritos a partir da implementação. Foram
  acrescentados [operations.md](../../operations.md), a [matriz](../../requirements-matrix.md) e o
  [pacote de entrega](../../submission.md). Todos os links relativos e âncoras dos Markdown do
  repositório foram verificados por script. As consultas SQL de diagnóstico foram executadas no
  stack isolado.

## Demonstração hospedada

A configuração em [deploy/hosted](../../../deploy/hosted/README.md) foi executada localmente como
projeto `jungle-issue14-hosted`, com `DEMO_ORIGIN=https://demo.localhost:8443`,
`AUTH_ORIGIN=https://auth.localhost:8443` e TLS interno do Caddy, publicado só em loopback:

| Verificação                                                                            | Resultado                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`, `/health/ready` (HTTPS)                                                       | 200                                                                                                                                                     |
| `http://`                                                                              | 308 → `https://`                                                                                                                                        |
| `/internal/metrics`                                                                    | 404 no proxy                                                                                                                                            |
| Keycloak `/realms/jungle/.well-known/openid-configuration`                             | 200, issuer `https://auth.localhost:8443/realms/jungle`                                                                                                 |
| Keycloak `/admin/`, `/admin/master/console/`, `/realms/master/`, `/metrics`, `/health` | 404                                                                                                                                                     |
| Portas publicadas                                                                      | somente Caddy; PostgreSQL, SQS, Keycloak e workers sem publicação, em rede `internal`                                                                   |
| HSTS / `nosniff`                                                                       | presentes                                                                                                                                               |
| `test:stack` com a senha gerada                                                        | 1 pass: login PKCE, disputa, replay, REFUND fora de ordem resolvido pelo worker e reconciliação `consistent`                                            |
| Mesma senha local `demo-only`                                                          | recusada pelo Keycloak                                                                                                                                  |
| Navegador                                                                              | Login redirecionado para `https://auth.localhost:8443/realms/jungle/…` e console autenticado como `demo-operator` ([captura](hosted-console-https.png)) |

O `.env` gerado e o realm renderizado foram apagados depois desse teste local.
Posteriormente a demo foi publicada na VPS autorizada, usando o perfil Traefik:
[validação pública](public-deployment.md). As pendências restantes estão em
[submission.md](../../submission.md).

## Vídeo

[`demo.mp4`](demo.mp4) tem 3 min 52 s, 1280×800, **narração em pt-BR** e legendas pt-BR como faixa
selecionável ([`demo.srt`](demo.srt)). A gravação original em 1920×1200 fica fora do Git
(`artifacts/demo/`). Foi produzido pelo pipeline do [roteiro](../../demo-script.md): narração
sintetizada (`edge-tts`, voz `pt-BR-AntonioNeural`), console real conduzido pelo Playwright no ritmo
de cada fala, e mixagem com ffmpeg que remove esperas mudas do stack (nesta execução o consumidor
SQS voltou sem espera, então nada foi cortado) e normaliza o áudio em −16 LUFS.
[`demo-run.json`](demo-run.json) guarda os dados reais da execução (2026-11-14 20:42–20:46 UTC, wallet `4cdf1c6a-de60-493a-9555-03a279aa3753`):

| Cena                                                                    | Resultado registrado                                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Prova 1 · Disputa (2 × BET 80,00 sobre 100,00)                          | `200 PROCESSED` e `422 REJECTED INSUFFICIENT_FUNDS`; saldo 20,00                                |
| Prova 2 · Replay (BET 5,00 duas vezes, mesma chave)                     | Mesmo `transactionId`; `idempotentReplay` false/true; saldo 15,00                               |
| Prova 3 · Fora de ordem (worker ativo)                                  | REFUND `202 PENDING_REFERENCE` no aceite, `PROCESSED` no estado atual; saldo 15,00              |
| Prova 4 · `docker compose kill reference-worker` + REFUND fora de ordem | O REFUND segue `PENDING_REFERENCE` com o worker morto                                           |
| `docker compose start reference-worker`                                 | REFUND `PROCESSED` após a retomada, 17,4 s depois do aceite; carimbo "Garantia mantida"         |
| `docker compose kill command-consumer` + BET 10,00 via SQS              | 1 mensagem na fila; depois do `start`, `PROCESSED`, saldo 5,00, versão 8                        |
| Reentrega com outro `messageId`                                         | Saldo 5,00 e versão 8 inalterados                                                               |
| Prova 5 · Reconciliação                                                 | `consistent: true`; registrado = reconstruído = 5,00; diferença 0,00; 8 lançamentos; placar 5/5 |

O vídeo está versionado apenas neste repositório privado. A forma de disponibilizá-lo aos
avaliadores ainda precisa de decisão ([submission.md](../../submission.md)). A morte depois do
commit e antes do ack, com coordenação exata, é provada pelo harness `test:recovery` (executado
acima), não pelo vídeo.
