# Demonstração hospedada

Esta configuração é reproduzível e serve para publicar o console e a API em HTTPS, com
autenticação e dados fictícios. É um diferencial escolhido por nós ([delivery.md](../../docs/delivery.md)),
não um requisito do README do desafio. A avaliação continua sendo o ambiente local.

> **Situação:** a configuração foi testada localmente com TLS interno (evidência em
> [issue-14](../../docs/evidence/issue-14/README.md#demonstração-hospedada)). **Nada foi publicado.**
> Destino, domínio, custo e forma de entregar as credenciais aos avaliadores ainda precisam de
> decisão; ver [docs/submission.md](../../docs/submission.md).

## Topologia

Um único host com Docker Compose. Somente o **Caddy** publica portas (80 → redirect e 443 HTTPS
com certificado ACME automático).

| Origem pública | Encaminha para | Bloqueado no proxy |
| --- | --- | --- |
| `DEMO_ORIGIN` (ex.: `https://demo.example.com`) | API + console (`api:3000`) | `/internal/*` (métricas) |
| `AUTH_ORIGIN` (ex.: `https://auth.example.com`) | Keycloak, apenas `/realms/jungle/*` e `/resources/*` | `/admin`, realm `master`, todo o resto |

PostgreSQL, LocalStack (SQS), workers e a porta de gerenciamento do Keycloak ficam em uma rede
Docker `internal`, sem portas publicadas e sem rota de saída. Prometheus e Grafana **não** fazem
parte da demo hospedada. `/health/live` e `/health/ready` continuam públicos, como o desafio exige.

Diferenças em relação ao Compose local:

- Keycloak roda em modo produção (`start`), com `KC_HOSTNAME` = `AUTH_ORIGIN` e cabeçalhos de proxy.
  O realm é renderizado a partir de `infra/keycloak/jungle-realm.json`, com `sslRequired: all`,
  proteção contra força bruta, redirect apenas para `DEMO_ORIGIN` e segredos gerados.
- Nenhuma credencial local é reaproveitada. `prepare.ts` gera senhas aleatórias para o banco, o
  papel de runtime, o admin do Keycloak, os clientes `provider-a`/`provider-b` e os três usuários.
  Se o realm renderizado ainda tiver `demo-only`, o script falha.
- O papel `jungle_runtime` recebe a senha gerada (`runtime-role.sql`). Os grants continuam nas
  migrations.
- O arquivo é independente do `compose.yaml` local de propósito. Um overlay herdaria toda
  credencial local que não fosse sobrescrita explicitamente. Para evitar divergência,
  `tests/unit/hosted-compose.test.ts` exige as mesmas imagens, os mesmos healthchecks e os mesmos
  comandos dos workers do Compose local. O teste também exige que só o Caddy publique portas e que
  não haja credenciais `demo-only`. O Keycloak escuta em 8080 aqui porque fica atrás do proxy; no
  local ele usa 18080 dentro e fora da rede para manter o issuer público coerente.

## Publicar

Requisitos do host: Linux com Docker e Compose v2, Bun 1.3.14 (apenas para `prepare.ts`), cerca de
4 GB de RAM livres, portas 80/443 abertas e dois nomes DNS apontando para o host.

```sh
git clone <repositório> && cd jungle-gaming-challenge
DEMO_ORIGIN=https://demo.example.com AUTH_ORIGIN=https://auth.example.com \
  bun deploy/hosted/prepare.ts            # gera deploy/hosted/.env (0600) e generated/jungle-realm.json
cd deploy/hosted
docker compose up -d --build --wait
PW="$(grep ^DEMO_OPERATOR_PASSWORD= .env | cut -d= -f2-)"
(cd ../.. && STACK_URL=https://demo.example.com STACK_PASSWORD="$PW" bun run test:stack)   # smoke
```

`deploy/hosted/.env` e `generated/` estão no `.gitignore`. Entregue as senhas dos usuários aos
avaliadores por um canal privado. Executar `prepare.ts` de novo preserva os segredos existentes.
Para trocar um segredo, apague a linha no `.env`, rode o script de novo e recrie os containers. O
Keycloak não tem volume, então o realm é reimportado a cada recriação.

Para testar localmente sem DNS nem ACME, use certificados internos do Caddy e `*.localhost` em uma
porta alta. Um override como o abaixo publica só em loopback:

```sh
DEMO_ORIGIN=https://demo.localhost:8443 AUTH_ORIGIN=https://auth.localhost:8443 \
  CADDY_GLOBAL_OPTIONS=local_certs bun deploy/hosted/prepare.ts
cat > /tmp/hosted-local.yaml <<'EOF'
services:
  caddy:
    ports: !override ["127.0.0.1:8443:8443", "[::1]:8443:8443"]
EOF
cd deploy/hosted && docker compose -p jungle-demo-local -f compose.yaml -f /tmp/hosted-local.yaml up -d --build --wait
docker compose -p jungle-demo-local cp caddy:/data/caddy/pki/authorities/local/root.crt /tmp/caddy-root.crt
PW="$(grep ^DEMO_OPERATOR_PASSWORD= .env | cut -d= -f2-)"
(cd ../.. && NODE_EXTRA_CA_CERTS=/tmp/caddy-root.crt STACK_URL=https://demo.localhost:8443 \
  STACK_PASSWORD="$PW" bun run test:stack)
```

## Operação e encerramento

- Os logs são JSON e não incluem payloads nem credenciais: `docker compose logs -f api`.
- Dados: volume `postgres-data`. Todo dado é fictício. `docker compose down -v` apaga a demo.
- Não há endpoints para matar processos ou executar comandos. As falhas do vídeo são provocadas
  apenas no ambiente local controlado ([docs/demo-script.md](../../docs/demo-script.md)).
- A demo não tem SLA. A reprodução local continua sendo a referência de avaliação.

## Estimativa de custo (referência, não contratada)

Uma VM de 2 vCPU e 4 GB em provedores comuns custa na ordem de US$ 5–25 por mês, e o domínio, se
for necessário, cerca de US$ 10–15 por ano. Os valores são aproximados e precisam ser confirmados
no provedor escolhido antes de qualquer contratação.

## Existing Coolify/Traefik proxy

Use `compose.traefik.yaml` when the host already runs Traefik with `http`/`https`
entrypoints and the `letsencrypt` resolver. Run `prepare.ts` first; it derives
`DEMO_HOST` and `AUTH_HOST` from the HTTPS origins. Only Caddy joins the external
`coolify` network (`TRAEFIK_NETWORK` overrides its name). No demo service publishes
host ports. Traefik terminates TLS and forwards to Caddy on port 8080; Caddy keeps
its realm and internal-route restrictions and forwards the public HTTPS scheme.
Dedicated backend DNS aliases avoid name collisions on the shared proxy network.

The overlay applies CPU/memory limits for a shared demo host. It is intended for
interactive evaluation, not load benchmarks. Build off-host and load the runtime
image with `docker save` / `docker load`; set `JUNGLE_IMAGE` to its immutable tag:

```sh
DEMO_ORIGIN=https://demo.example.com AUTH_ORIGIN=https://auth.example.com \
  bun deploy/hosted/prepare.ts
cd deploy/hosted
JUNGLE_IMAGE=jungle-demo:<commit> docker compose \
  -f compose.yaml -f compose.traefik.yaml up -d --no-build --wait
```

The existing proxy, its certificates and unrelated services are not recreated.
On a cold first start, Keycloak prepares its production image and imports the
realm under its CPU limit. The profile gives it 120 seconds of healthcheck startup
grace without weakening readiness; allow `--wait-timeout 420` for deployment.
Stop only this project with the same Compose files; preserve its PostgreSQL volume
unless intentionally deleting the fictitious demo data. Verify HTTPS, login,
`test:stack`, blocked administration paths and resource consumption after deployment.
