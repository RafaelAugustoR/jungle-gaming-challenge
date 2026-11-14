# Demonstração pública — 2026-11-14

- Console/API: https://jungle.178-18-253-17.sslip.io
- Login: https://jungle-auth.178-18-253-17.sslip.io
- VPS existente: 4 vCPUs, aproximadamente 8 GiB de RAM. Sem contratação nova.
- Aplicação: imagem `jungle-demo:1b7355c`, construída fora do servidor.
- Perfil do proxy: `f7cd73c`, integrado ao Traefik existente, sem recriar serviços alheios.

## Validação externa

- HTTPS validado com a cadeia normal de certificados, sem ignorar erros TLS.
- 11 verificações passaram: console, health, issuer, redirect HTTP→HTTPS,
  consulta sem autenticação recusada e bloqueio de métricas/admin/realm master.
  [Resultados](public-checks.json).
- `test:stack` contra a URL pública: um teste passou, 14 assertions, aproximadamente
  21 segundos. Exercita login PKCE, duas apostas concorrentes, replay, REFUND fora
  de ordem com o worker real e reconciliação consistente.
- Chrome real: login de `demo-operator` concluído, retornando ao console HTTPS.
  [Captura autenticada](public-console.png).

## Isolamento e recursos

O projeto Compose é `jungle-demo`. Nenhum container da demo publica porta no host;
somente Caddy participa da rede externa do proxy. Banco, SQS, Keycloak e processos
de aplicação usam a rede privada. Traefik termina TLS; Caddy preserva os filtros
e informa o esquema público HTTPS ao backend.

Na amostra após a subida, os nove containers usavam aproximadamente 1,4 GiB de RAM
no total e o host mantinha cerca de 3,2 GiB disponíveis. Não havia containers
unhealthy no servidor. Isso é uma amostra operacional, não um teste de carga.
CPU/memória têm limites explícitos no overlay; o benchmark continua sendo a
evidência controlada da Issue #13.

O primeiro arranque do Keycloak excedeu a janela de healthcheck enquanto preparava
a imagem e importava o realm, sem OOM ou reinício. O perfil passou a dar 120 segundos
de startup grace, mantendo o mesmo endpoint de readiness e timeout de deploy de
420 segundos. A nova subida concluiu saudável.

## Operação

Diretório no servidor: `~/apps/jungle-demo/current/deploy/hosted`.
Para inspecionar apenas essa demo:

```sh
JUNGLE_IMAGE=jungle-demo:1b7355c docker compose -p jungle-demo \
  -f compose.yaml -f compose.traefik.yaml ps
```

Senhas e realm gerados ficam fora do Git e não estão nas evidências. Os perfis
disponíveis são `viewer`, `operator` e `demo-operator`; o autor entrega suas senhas
por canal privado. O repositório continua privado e nenhuma submissão foi feita.
