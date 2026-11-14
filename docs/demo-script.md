# Roteiro do vídeo de demonstração

Este vídeo curto (~3 min) é um diferencial escolhido por nós ([delivery.md](delivery.md)). Ele
mostra disputa de saldo, replay idempotente, referência fora de ordem, falha e recuperação de
processos e a reconciliação final, sempre com dados reais da execução. O console mostra o recibo
original e o estado atual lado a lado.

As falhas são provocadas **somente** no stack local com `docker compose kill`. A aplicação não tem
endpoint para matar processos nem para executar comandos. A morte depois do commit e antes do ack,
os publishers concorrentes e as quedas isoladas de PostgreSQL e SQS são provados com coordenação
precisa no harness `bun run test:recovery` ([issue-12](evidence/issue-12/README.md)).

## Gravar

```sh
docker compose --profile events up -d --build      # stack local
cp .env.example .env && bun install --frozen-lockfile
CONSOLE_URL=http://localhost:3000 bun run demo:record artifacts/demo
# Chrome do sistema, se o Chromium do Playwright não estiver instalado:
CHROME_PATH=/usr/bin/google-chrome bun run demo:record artifacts/demo
ffmpeg -i artifacts/demo/demo.webm -c:v libx264 -crf 30 -preset slow -pix_fmt yuv420p artifacts/demo/demo.mp4
```

`scripts/record-demo.ts` conduz o console real com Playwright (1280×800), sobrepõe legendas e um
painel com os comandos e as saídas reais, e grava `demo.webm` e `demo-run.json`. Esse JSON guarda
os IDs, os recibos, os estados e as respostas daquela execução. O script usa as variáveis do `.env`
e do Compose do shell atual (`COMPOSE_PROJECT_NAME`/`COMPOSE_FILE`). `DEMO_PACE_MS` ajusta o tempo
de leitura das legendas.

## Cenas

| # | Cena | Ação | O que deve aparecer |
| --- | --- | --- | --- |
| 0 | Abertura | `GET /health/ready` | `{"status":"ok","checks":{"postgres":true,"sqs":true}}` |
| 1 | Login e wallet | Keycloak PKCE como `demo-operator`; criar a wallet com 100.00 | Saldo 100.00, versão 1, OPENING no ledger |
| 2 | Disputa de saldo | Cenário **Disputa pelo saldo** (2 × BET 80.00 em paralelo) | Uma `200 PROCESSED` e uma `422 REJECTED INSUFFICIENT_FUNDS`; saldo 20.00; um débito |
| 3 | Replay idempotente | **Repetição idempotente** com 5.00 (mesma chave em paralelo) | Um `transactionId`, um recibo com `idempotentReplay: true`; saldo 15.00 |
| 4 | Falha e referência fora de ordem | `docker compose kill reference-worker`; **Referência fora de ordem** com 5.00 | REFUND `202 PENDING_REFERENCE` continua pendente com o worker morto |
| 5 | Recuperação | `docker compose start reference-worker` | REFUND `PROCESSED`; o detalhe mostra o recibo 202 original ao lado do estado atual |
| 6 | Consumidor SQS | `docker compose kill command-consumer`; BET 10.00 pela fila; `start` | A mensagem espera na fila; depois do restart a transação fica `PROCESSED` e o saldo 5.00 |
| 7 | Reentrega | Mesma operação com outro `messageId` | Saldo e versão inalterados |
| 8 | Reconciliação | **Reconciliar ledger** | `consistent=true`; registrado = reconstruído; diferença 0.00 |
| 9 | Encerramento | — | Referência às provas automatizadas (`test:recovery`) |

Na cena 4, a BET referenciada é processada na hora (débito de 5.00) e o REFUND só credita depois
da recuperação. Por isso o saldo volta a 15.00 antes da cena 6.

## Execução registrada

A gravação desta entrega, com o JSON da execução, está em
[evidence/issue-14](evidence/issue-14/README.md#vídeo).
