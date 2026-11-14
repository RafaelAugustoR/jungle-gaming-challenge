# Roteiro do vídeo de demonstração

Este vídeo curto (~2 min) é um diferencial escolhido por nós ([delivery.md](delivery.md)). Ele
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
| 1 | Login e wallet | Keycloak PKCE como `demo-operator`; criar a wallet com R$ 100,00 | Saldo R$ 100,00 no trilho, versão 1 |
| 2 | Prova 1 · Disputa | 2 × BET de 80% do saldo em paralelo | Um bilhete `200 PROCESSED`, outro `422 REJECTED INSUFFICIENT_FUNDS`; carimbo "Garantia mantida"; saldo R$ 20,00 |
| 3 | Prova 2 · Replay | Mesma chave em paralelo, R$ 5,00 | Um `transactionId`, segundo recibo com replay; saldo R$ 15,00 |
| 4 | Prova 3 · Fora de ordem | REFUND antes da BET, R$ 5,00 | Canhoto `202 PENDING_REFERENCE`, validação `PROCESSED` com "mudou desde o aceite"; saldo inalterado |
| 5 | Prova 4 · Falha e recuperação | `docker compose kill reference-worker`; executar; `docker compose start reference-worker` | Validação "Aguardando referência" com o cronômetro; depois `PROCESSED` e carimbo com o tempo de pendência |
| 6 | Consumidor SQS | `docker compose kill command-consumer`; BET 10,00 pela fila; `start` | A mensagem espera na fila; depois do restart a transação fica `PROCESSED` e o saldo R$ 5,00 |
| 7 | Reentrega | Mesma operação com outro `messageId` | Saldo e versão inalterados; o Ledger fecha com o saldo da wallet |
| 8 | Prova 5 · Reconciliação | Executar a prova | Bilhete de conferência: reconstruído = registrado, diferença R$ 0,00; placar 5/5 |
| 9 | Encerramento | — | Referência às provas automatizadas (`test:recovery`) |

## Execução registrada

A gravação desta entrega, com o JSON da execução, está em
[evidence/issue-14](evidence/issue-14/README.md#vídeo).
