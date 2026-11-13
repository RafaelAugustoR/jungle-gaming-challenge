# Issue #8 — publicação recuperável

Requisito do desafio: eventos financeiros devem chegar a uma fila separada após o commit. A Issue #8 aplica R19/R20/R24 da [spec](../../spec.md), sem operação SQS dentro da transação financeira.

## Executar

```sh
bun install --frozen-lockfile
INTEGRATION=1 bun test tests/integration/outbox.test.ts
bun run test:integration
```

Os testes criam bancos PostgreSQL descartáveis e filas SQS FIFO com UUIDs. Não limpam o banco de desenvolvimento nem reutilizam filas entre execuções. LocalStack executa SQS; não há mock do transporte ou da persistência. O helper de processo usa o mesmo publisher da aplicação; callbacks de observação existem somente como barreiras explícitas para matar o processo antes/depois do envio.

## Provas automatizadas

| Cenário               | Evidência verificada                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Reservas concorrentes | `SKIP LOCKED` reserva cabeças distintas; token incorreto não confirma                             |
| Dois processos        | PIDs distintos publicam três wallets cada; seis IDs únicos confirmados                            |
| Morte antes do envio  | SIGKILL após reserva; outro processo recupera a lease expirada, preservando eventId               |
| Morte após envio      | SIGKILL após resposta SQS e antes da confirmação; recuperação reenvia o mesmo eventId             |
| Fencing               | Proprietário expirado não confirma; tentativa seguinte aumenta contador persistido                |
| Ordenação             | Eventos 2/3 de uma BET aguardam confirmação dos predecessores da mesma wallet                     |
| Isolamento            | Cabeça em backoff não impede publicação de outra wallet                                           |
| Falha de transporte   | Fila ausente mantém evento pendente e agenda nova tentativa                                       |
| Falha permanente      | Rejeição de conteúdo fica retida; erros de credencial usam retry automático e backoff global      |
| Inbox persistente     | Reentrega é reconhecida e apagada da fila somente após commit                                     |
| Projeção              | Evento atrasado não reduz sequência, versão ou saldo; ID reutilizado com outro payload é recusado |
| Atomicidade           | Falha injetada na projeção desfaz também a inbox; tentativa seguinte aplica o evento              |
| Imutabilidade         | Papel runtime não altera payload nem apaga outbox                                                 |

A expiração nos testes altera o prazo persistido com o papel proprietário em banco descartável. Isso evita depender de sleeps; a condição de posse é sempre avaliada pelo relógio PostgreSQL. Não se corrompe mais o payload no teste: o publisher confia no evento persistido; o parse ocorre apenas na fronteira do consumidor. A política pura testa classificação/jitter, e um erro de credencial é injetado somente no adaptador SQS para provar liberação da lease e retomada sem reset.

## Validação local

Em 13/11/2026: `bun run build`, `bun test` (32 aprovados; integrações desabilitadas nesse comando), `docker compose --profile events config --quiet` e a suíte completa `bun run test:integration` passaram. A suíte completa executou 66 testes de integração/concorrência, com 467 asserções e um teste exclusivo de navegador pulado. Em seguida, a suíte específica foi ampliada com smoke dos entrypoints de produção e fencing após troca de proprietário; a execução final passou com 9 testes e 70 asserções, incluindo os entrypoints reais. Nenhum teste de navegador foi necessário para esse recorte sem mudanças visuais.

## Garantias e limites

A entrega é **pelo menos uma vez**. A deduplicação FIFO de cinco minutos não substitui a inbox. Cada wallet tem um grupo SQS e somente a primeira entrada não publicada pode ser reservada. Leases expiradas não revogam um envio já em voo: uma cópia antiga pode chegar depois, por isso o consumidor também protege a sequência e a versão da projeção. Não há afirmação de exactly-once no transporte.

A projeção demonstra o último saldo observado, com consistência eventual. Não substitui o ledger nem serve para autorizar apostas. Inbox, outbox e eventos bloqueados não têm expurgo automático nesta entrega. O consumidor demonstrativo não descarta mensagens inválidas; o redrive nativo move-as para a DLQ FIFO após cinco recebimentos. O teste usa visibility zero para provar cinco falhas e entrega na DLQ real sem sleeps; um evento válido atrás do poison no mesmo grupo FIFO recebe ack e não segue para a DLQ. O provisionamento também atualiza filas já existentes. A DLQ tem retenção de 14 dias e requer investigação/redrive manual após corrigir a causa. Não se cria outro journal ao consumir eventos.

## Rodada de revisão

As threads operacionais foram tratadas com testes de política, credenciais, DLQ real, isolamento por mensagem, schema separado e bootstraps independentes. O publisher deixou de revalidar o evento próprio; a sequência ainda é enriquecimento de transporte para evitar alterar os writers financeiros no recorte paralelo da Issue #6. O parser do consumidor deriva os tipos das classes concretas e inclui causationId. Separação de principals SQL foi documentada como endurecimento posterior; grants seguem explícitos e nenhum privilégio financeiro novo foi concedido.

Validação da revisão: suíte completa com **69 aprovados, 483 asserções e um teste exclusivo de navegador pulado**. A suíte específica cobre 11 cenários (76 asserções após incluir provisionamento idempotente de fila existente). Quatro testes unitários adicionais cobrem classificação, jitter, configuração independente e envelope com causação.

## Segunda rodada de revisão

O parser agora usa o conjunto canônico de tipos de aposta (incluindo REFUND) e as constantes das classes de eventos. Um teste processa BET e REFUND reais, publica cinco eventos e comprova o recibo do evento REFUND na inbox e a projeção final. O teste de poison usa agora o mesmo grupo FIFO para o evento válido; somente poison chega à DLQ.

`InvalidParameterValue` permanece ambíguo: somente quando uma consulta bem-sucedida confirma que o corpo UTF-8 excede `MaximumMessageSize` o publisher registra `MessageTooLarge` e bloqueia aquela cabeça. O teste real configura a fila com 1024 bytes, conserva o evento grande e publica uma wallet saudável sem backoff global. Se não houver prova de excesso, inclusive se o diagnóstico falhar, o evento continua retryable. A [API SendMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessage.html) documenta teto atual de 1 MiB; [MaximumMessageSize](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SetQueueAttributes.html) é configurável de 1024 a 1048576 bytes. Não se presume o antigo default de 256 KiB do emulador.

A configuração de polling usa o mesmo helper de inteiro decimal dos demais tempos, rejeitando `1e3`, decimais e espaços. A regex única do nome preserva espaço para o sufixo de DLQ. A revisão também integra a main com a migration0005 e mantém a política real de referências no fixture de submissão.

Validação final da segunda rodada, já com a main da Issue #6: **80 integrações/concorrência aprovadas, 589 asserções e um teste exclusivo de navegador pulado**; **35 unitários aprovados, 192 asserções**. Os 13 cenários de outbox, incluindo REFUND real, poison/validação no mesmo grupo e tamanho da fila real, passaram. Build/typecheck, Compose config e diff-check também passaram.
