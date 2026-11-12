# Especificação — Distributed Wagering Processor

Status: implementação incremental. Bootstrap (#2) e abertura autenticada de wallet (#3) têm evidências próprias; a matriz continua sendo o contrato completo, sem presumir entregas dos próximos tickets.

Fonte normativa: [README da Jungle Gaming](https://github.com/junglegaming/backend-challenge), consultado em 2026-11-11. Decisões do grill estão nas ADRs 0001–0017. Legenda: **R** = exigência do README; **A** = decisão aprovada; **D** = detalhamento técnico desta especificação, não apresentado como aprovação anterior.

## Problem Statement

Provedores de jogos enviam operações financeiras com entrega at-least-once, concorrência e referências fora de ordem. O sistema precisa impedir efeitos duplicados e saldo negativo, manter saldo e ledger consistentes e recuperar trabalho após falhas de processo, banco ou mensageria. O avaliador deve conseguir reproduzir essas garantias e inspecionar decisões, testes e limitações.

## Solution

Monólito modular com Bun 1.x, TypeScript estrito, NestJS, MikroORM, PostgreSQL e SQS em emulador local, executável por Docker Compose. API, consumidor, publisher e worker de referências executam separadamente sobre o mesmo núcleo financeiro. Uma transação SQL confirma a operação, saldo, ledger, inbox aplicável, recibo e outbox. Locks por wallet e constraints persistentes sustentam a correção entre instâncias.

Keycloak separa identidades humanas e de provedores. Um console permite consultar operações e executar demonstrações autorizadas, complementado por Prometheus/Grafana, teste de carga, implantação de demonstração e vídeo. A execução local permanece independente da hospedagem.

## User Stories

1. Como provedor, quero submeter BET para debitar saldo sem permitir saldo negativo.
2. Como provedor, quero submeter WIN com referência opcional para registrar créditos válidos.
3. Como provedor, quero registrar LOSS sem movimentar saldo.
4. Como provedor, quero REFUND integral de BET processada para desfazer seu débito.
5. Como provedor, quero ROLLBACK de BET, WIN ou REFUND para inverter o efeito original.
6. Como provedor, quero uma rejeição auditável quando uma reversão exigiria saldo negativo.
7. Como provedor, quero repetir uma submissão sem duplicar efeitos financeiros.
8. Como provedor, quero conflito explícito se reutilizar uma chave com outro conteúdo.
9. Como provedor, quero consultar uma operação por seu ID externo mesmo após perder a resposta HTTP.
10. Como provedor, quero que uma referência atrasada seja aguardada sem bloquear a fila de entrada.
11. Como provedor, quero saber por código estável quando uma referência é inválida ou expirou.
12. Como integrador, quero os mesmos efeitos e validações financeiras por HTTP e SQS.
13. Como integrador, quero identidades independentes para que um provedor não atue como outro.
14. Como viewer, quero consultar wallet, transações e histórico paginado para acompanhar operações.
15. Como operator, quero reconciliar saldo e ledger sem corrigir divergências silenciosamente.
16. Como demo-operator, quero criar wallets fictícias com abertura contabilizada.
17. Como demo-operator, quero disparar cenários de disputa, duplicação e referências atrasadas.
18. Como operador técnico, quero eventos confirmados recuperáveis após morte do publisher.
19. Como operador técnico, quero retries, DLQ e diagnóstico sem perder mensagens inválidas.
20. Como operador técnico, quero encerrar workers sem confirmar trabalho não persistido.
21. Como operador técnico, quero acompanhar latência, locks, retries e outbox lag em um dashboard.
22. Como auditor, quero lançamentos imutáveis e partidas balanceadas para reconstruir o saldo.
23. Como avaliador, quero executar a mesma aposta cinquenta vezes em paralelo e observar um único débito.
24. Como avaliador, quero comprovar correção com pelo menos três processos independentes.
25. Como avaliador, quero derrubar um worker após commit e antes do ack e comprovar recuperação.
26. Como avaliador, quero comparar carga em uma wallet e em várias sem confundir rejeições com erros.
27. Como avaliador, quero subir o ambiente limpo e executar testes sem depender de serviços financeiros reais.
28. Como avaliador, quero explorar uma demonstração hospedada e um vídeo com evidências verificáveis.

## Implementation Decisions

### Arquitetura e responsabilidades

**R/A:** stack e estrutura aprovadas no grill. Wagering coordena a operação; Wallets encapsula saldo, ledger e reconciliação; Identity autoriza chamadas; Demo controla cenários; Messaging implementa transporte, inbox e outbox. Não há commits independentes entre módulos de uma operação financeira. Cada requisição/trabalho usa contexto isolado do MikroORM.

**D:** selecionar e fixar versões compatíveis em lockfile e imagens durante o bootstrap; validar primeiro Bun + NestJS + MikroORM + emulador. Escolher LocalStack ou MiniStack conforme suporte reproduzível às operações SQS utilizadas, documentando a escolha antes dos testes. Não presumir compatibilidade por usar a versão mais recente. Domínio usa classes com construtores private/protected e factories; rehydrate reconstrói estado sem executar novamente transições. Classes concretas de eventos derivam de IntegrationEvent, com tipo e versão definidos na classe.

### Money e entradas

**R/A:** Money imutável com decimal.js; moeda explícita; contratos em string; BRL operacional, modelo multimoeda; aritmética entre moedas distintas falha. Negativos são permitidos internamente para diferenças e negate, não em submissões.

**D:** aceitar apenas representação decimal não negativa com exatamente duas casas, sem espaços, sinal, expoente, zeros à esquerda redundantes, NaN ou Infinity. Limite de valor individual e saldo: 9999999999999999.99; decimal.js com precisão 40 para operações individuais. Agregações do ledger são feitas com SUM NUMERIC no PostgreSQL, não por redução decimal de precisão limitada. Diferenças de reconciliação podem ser negativas e não devem ser truncadas ao limite de entrada.

Persistir NUMERIC sem coerção de escala, com checks explícitos de finitude, escala máxima 2, faixa e não-negatividade quando aplicável. Assim a escrita SQL de 0.001 é rejeitada, não arredondada antes do CHECK. Valores do driver permanecem strings.

**D — interpretação de zero:** abertura zero não cria OPENING nem ledger. Operações externas de valor zero são aceitas, respeitando referências e idempotência: não geram ledger, mudança de versão nem WalletBalanceChanged; geram o resultado da transação. Isso segue a regra geral de não criar lançamento sem efeito em saldo, especializando a tabela resumida de operações do README. Não criar artificialmente débito ou crédito zero. LOSS aceita valor não negativo como dado de negócio, mas nunca movimenta saldo. Documentar e testar esse comportamento.

### Wallet, estados e operações

**R:** uma wallet por playerId + currency, version inicial 1. Abertura positiva cria OPENING, crédito na wallet e contrapartida na mesma transação; version continua 1. Mudanças posteriores de saldo incrementam version exatamente uma vez; LOSS, rejeição, replay e movimentos zero não incrementam.

Estado inicial PENDING. Transições permitidas: PENDING → PENDING_REFERENCE, PROCESSED, REJECTED ou FAILED; PENDING_REFERENCE → PROCESSED, REJECTED ou FAILED. Uma nova tentativa ainda sem referência atualiza o agendamento, não inventa uma transição nem outro evento de entrada em pendência. Estados terminais não transitam; replay não invoca métodos de transição.

BET debita; WIN credita; LOSS registra resultado; REFUND credita exatamente o valor de BET processada; ROLLBACK inverte BET, WIN ou REFUND processados. OPENING externo é inválido. Identidade da wallet deve corresponder ao jogador e moeda. Provedor deve ser conhecido. Não impor saldo suficiente para LOSS nem igualdade de valor entre WIN e BET.

**A:** referência, quando aplicável, deve coincidir em provedor, jogador, wallet, moeda e rodada. REFUND e ROLLBACK exigem referência; WIN sem referência é permitido, com referência exige BET processada. Incompatibilidade conhecida rejeita imediatamente; ausência/pendência aguarda; referência terminalmente rejeitada/falha rejeita. Não adicionar regra de uma única WIN/LOSS por rodada, ausente no enunciado. **D:** referência opcional em LOSS, quando fornecida, identifica BET e usa a mesma política de validação/espera; referência em BET é rejeitada. Autorreferência é inválida.

**A:** unicidade de reversões aplicadas é por referência + kind. REFUND e ROLLBACK da mesma BET são permitidos, conforme interpretação literal aprovada; teste documenta saldo 100 → 80 → 100 → 120. ROLLBACK do REFUND é outra operação, com efeito de débito. Rejeições não consomem uma reversão aplicada, mas permanecem terminais sob sua própria chave.

### Idempotência, hash e recibo

**A:** unicidades persistentes por (providerId, idempotencyKey) e (providerId, externalTransactionId). Chave HTTP obrigatória e não derivada automaticamente. Mesma chave + mesmo hash retorna recibo; payload distinto ou nova chave para a mesma operação externa retorna 409. Identidades de provedores diferentes são independentes. Não expirar registros de idempotência durante esta entrega.

**D:** SHA-256 de JSON com chaves ordenadas recursivamente, UTF-8, sem espaços extras, dos campos providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money e referenceExternalTransactionId se presente. Validar primeiro; distinguir campo ausente de null, rejeitando null onde não previsto. Não incluir chave, timestamps de transporte, correlationId, messageId ou autenticação. Recusar campos desconhecidos nos contratos financeiros. HTTP e SQS constroem exatamente o mesmo comando canônico.

Recibo persistido atomicamente para toda operação aceita, inclusive rejeição de negócio. Contém status HTTP, transactionId, estado original, saldo observado quando disponível e failureCode quando aplicável. Replay altera somente idempotentReplay no corpo; o identificador de correlação de transporte atual pode ir em header. GET retorna o estado atual. Pendência aceita com 202 mantém esse recibo mesmo após conclusão. Validação/autorização anteriores ao aceite e falhas SQL transitórias não consomem a chave. Commit incerto é resolvido por consulta/repetição da mesma chave, nunca por nova chave.

### Concorrência e schema

**A:** locks por wallet, transações curtas e nenhuma chamada de rede dentro da transação financeira.

**D:** ordem comum a todos os caminhos: adquirir inbox aplicável; bloquear wallet; localizar/reservar a identidade da transação; ler/validar referência; aplicar estado e lançar ledger/outbox. Worker de referências seleciona candidatos sem manter lock na transação antes de obter a wallet e revalida tudo sob o lock. Não bloquear outra wallet ao descobrir referência incompatível. Conflito UNIQUE é resolvido após rollback, consultando registro existente para replay ou 409; não continuar em uma transação abortada. Deadlock/timeout recebe retry limitado, até três tentativas por chamada, respeitando o prazo total.

| Registro | Garantias no banco |
| --- | --- |
| Wallet | UNIQUE jogador/moeda; saldo exato não negativo; versão válida; associação à conta do jogador. |
| Transação | Duas unicidades de identidade; referência por FK; campos financeiros imutáveis após aceite; estados e transições válidos; failureCode em rejeição/falha; índice único parcial referência/kind para reversões PROCESSED. |
| Journal financeiro | Uma linha representa o par débito/crédito: contas diferentes, moeda única, valor positivo único para ambos os lados, vínculo único à transação; FK para contas e restrições de moeda. |
| Ledger da wallet | Derivado da participação do jogador no journal, com direção, balanceBefore, balanceAfter e walletVersion persistidos; unicidade wallet/transação e wallet/versão; aritmética verificada. |
| Inbox | UNIQUE consumerName/messageId; hash persistido e marca de processamento; não substituir hash de mensagem existente. |
| Outbox | eventId único e payload imutável; estado de publicação separado, reserva e tentativas persistidas; índices de pendentes vencidos. |

**D:** representar o par financeiro em uma linha evita a possibilidade de confirmar apenas uma das duas partidas. Não duplicar fatos financeiros em um segundo ledger mutável. Contrapartidas de abertura e de jogos não têm saldo global atualizado por aposta.

Triggers e constraints verificam, no commit, correspondência entre mudança de saldo/versão e journal, continuidade da cadeia de lançamentos e compatibilidade com transação processada. Abertura positiva é a exceção explícita de versão inicial 1. Wallet criada com saldo positivo sem lançamento e lançamento isolado sem atualização de wallet devem falhar. A verificação incremental compara extremos da cadeia por índices; reconciliação faz reconstrução completa. Gatilhos de escrita e permissões bloqueiam UPDATE/DELETE/TRUNCATE do journal para a aplicação; usuário de runtime não é dono das tabelas, superuser ou usuário de migrations. Migrations incluem reversão dos objetos; teardown só ocorre em banco descartável.

### API e autorização

| Contrato | Resultado |
| --- | --- |
| POST /wallets | 201, id, playerId, balance, version; duplicação retorna 409. |
| GET /wallets/:walletId | Estado atual ou 404. |
| GET /wallets/:walletId/ledger?cursor=...&limit=50 | Histórico estável e cursor opaco. |
| POST /wagering/transactions | 200 processada, 202 pendente ou 422 rejeitada; recibo estável. |
| GET /wagering/transactions/:transactionId | Estado atual, failureCode, referência e resultado financeiro disponíveis. |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId | Mesma consulta pela identidade externa. |
| POST /wallets/:walletId/reconciliation | storedBalance, calculatedBalance, difference, consistent e checkedEntries. |
| GET /health/live e /health/ready | Liveness do processo; readiness de PostgreSQL e SQS, sem autenticação. |

**D:** paginação por versão financeira crescente, cursor validado e vinculado à wallet, contendo limite superior capturado na primeira página. Limite padrão 50 e máximo 100. Não usar offset nem depender somente de timestamps. Reconciliação obtém snapshot consistente de wallet e ledger, calcula difference = storedBalance − calculatedBalance; divergência retorna 200 com consistent=false, log e métrica, sem correção.

**A:** 400 payload inválido, 401 token inválido/ausente, 403 autorização/identidade incompatível, 404 consulta inexistente, 409 conflito, 422 rejeição financeira, 503 infraestrutura transitória, 500 inesperado. GET de REJECTED retorna 200. Códigos mínimos: INVALID_PAYLOAD, IDEMPOTENCY_CONFLICT, EXTERNAL_TRANSACTION_CONFLICT, WALLET_ALREADY_EXISTS, WALLET_NOT_FOUND, PLAYER_MISMATCH, CURRENCY_MISMATCH, UNKNOWN_PROVIDER, INSUFFICIENT_FUNDS, REVERSAL_INSUFFICIENT_FUNDS, REFERENCE_REQUIRED, REFERENCE_KIND_MISMATCH, REFERENCE_CONTEXT_MISMATCH, REFERENCE_AMOUNT_MISMATCH, REFERENCE_NOT_PROCESSED, REFERENCE_NOT_FOUND, REFERENCE_NOT_READY, ALREADY_REVERSED, AMOUNT_LIMIT_EXCEEDED, INFRASTRUCTURE_UNAVAILABLE. A especificação de erro inclui code, mensagem e correlationId; transações rejeitadas incluem transactionId/failureCode.

**D:** wallet inexistente em submissão não pode criar lançamento nem transação com FK inválida; retorna 404 como recurso necessário inexistente. Códigos de transporte não implicam persistência de uma transação. Não revelar dados de outro provedor em mensagens de conflito.

**A:** viewer consulta; operator também reconcilia; demo-operator também cria wallets e dispara cenários. Keycloak é IdP externo; clientes de máquina distintos por provedor, vinculados ao providerId. Verificar issuer, audience, assinatura, expiração e permissões. Navegador usa cliente público com PKCE, sem segredo de máquina. Credenciais de simulação ficam no backend, com auditoria de ator humano e provedor.

**D:** provedores podem submeter e consultar suas próprias transações; não recebem acesso genérico a wallets/ledger compartilhados. Consultas por ID interno também verificam ownership da transação. Endpoints de wallet e ledger são do console. Dados do console pertencem a uma única operação de demonstração; não implementar tenancy não solicitada. Rotas adicionais de listagem e cenários serão documentadas como extensões e não alteram os contratos obrigatórios.

### Referências pendentes

**A:** TTL 15 minutos desde primeira aceitação, persistido e não renovado por replay. Backoff de 1 segundo com teto 30 segundos e jitter. Expiração distingue REFERENCE_NOT_FOUND de REFERENCE_NOT_READY; infraestrutura indisponível não prova ausência.

**D:** jitter entre metade e total do intervalo exponencial, próxima tentativa limitada pelo prazo de expiração. Sob lock da wallet, se a referência foi processada até o deadline, concluir mesmo que o worker tenha sido atrasado. Se foi processada somente após o deadline, rejeitar como REFERENCE_NOT_READY; se ausente, REFERENCE_NOT_FOUND. Demais incompatibilidades já conhecidas seguem os códigos específicos. Usar horário do banco como referência de timestamps persistidos. Ciclos não resolvidos expiram; autorreferência rejeita imediatamente. Rejeição e evento da expiração são atômicos.

### SQS, inbox e DLQ

**R:** filas wager-transactions.fifo e wager-transactions-dlq.fifo; envelope messageId, type=WagerTransactionRequested, occurredAt e data com os campos do comando e idempotencyKey. messageId de negócio é distinto do MessageId atribuído pelo SQS.

**A:** mesmo caso de uso HTTP/SQS, inbox por consumerName/messageId e ack somente após commit. Pendência persistida recebe ack e passa ao worker agendado. Retry transitório com backoff; maxReceiveCount=5. Canal SQS interno confiável, sem OAuth por mensagem; validação do provedor permanece.

**D:** usar walletId como MessageGroupId. Deduplicação FIFO é otimização: testes variam o identificador de transporte para garantir que duplicatas alcancem a aplicação. Inbox compara hash do conteúdo de negócio incluindo idempotencyKey; excluir timestamps e identificadores de transporte. Mesmo messageId com conteúdo divergente gera diagnóstico de conflito e DLQ, nunca sobrescreve inbox. Outro messageId com operação idempotente apenas registra processamento da nova mensagem, sem novo evento financeiro.

Mensagem permanentemente inválida é enviada à DLQ antes de remover a origem, preservando identificador original e motivo. Usar identificador determinístico para deduplicação do envio; uma falha entre send e delete ainda pode duplicar a entrega fora da janela FIFO, portanto ferramentas de diagnóstico identificam duplicatas pelo ID original. Nenhuma mensagem é descartada por uma falha no envio à DLQ. Erros de negócio válidos persistem REJECTED e recebem ack; conflitos de contrato que não representam nova operação financeira vão para DLQ.

**D:** visibility inicial 30 s, renovação enquanto o trabalho válido estiver em andamento; timeout de chamada SQS 5 s, lock SQL 3 s, statement 5 s e prazo total por processamento 15 s, todos configuráveis e verificados em ambiente real. Backoff transitório base 1 s, teto 30 s e jitter. Em SIGTERM parar polling, drenar por até 20 s, cancelar/rollback dos trabalhos restantes e só então devolver visibilidade; se não puder devolver, ela expira. Lease/visibilidade não substituem idempotência.

DLQ não implica automaticamente FAILED: mensagem malformada pode não possuir transação. FAILED só é aplicável a operação persistida não terminal com erro permanente identificado, sem efeito financeiro; não converter indisponibilidade do banco ou esgotamento de transporte em rejeição financeira. Registrar failures operacionalmente, com transição auditável quando aplicável. Não reabrir estados terminais pelo redrive.

### Outbox e consumo de eventos

**R/A:** publicar WagerTransactionProcessed (incluindo LOSS), WagerTransactionRejected, WalletBalanceChanged somente quando saldo muda e WagerTransactionPendingReference na entrada em pendência. Envelope inclui eventId, aggregateId, correlationId, causationId opcional, occurredAt ISO, eventType, version e data com MoneyProps, nunca objetos do ORM.

**D:** queue de saída separada wager-events.fifo, para não misturar comandos e eventos. Consumidor demonstrativo com inbox própria comprova efeitos idempotentes e fornece evidência de publicação. Falha permanente de transação pode gerar evento adicional WagerTransactionFailed, documentado como extensão. Replays não geram novamente eventos de negócio.

**A:** publisher reserva via SKIP LOCKED, publica fora da transação financeira e confirma apenas se ainda detiver a reserva. Lease inicial 30 s, lotes pequenos e timeouts de envio menores que o lease. Tokens de posse impedem confirmação por worker antigo, mas não garantem impedir envio tardio ao SQS. eventId permanece estável em republicações. Backoff base 1 s, teto 60 s; evento com falha permanente permanece retido e sinalizado, sem descarte.

**D:** sequência persistida por wallet para eventos, separada de wallet.version porque LOSS e pendência também geram eventos. Reservar apenas o primeiro evento ainda não publicado de cada wallet, avançando após confirmação. MessageGroupId=walletId, deduplicationId=eventId. Publicações tardias ainda podem entregar duplicata antiga; consumidores deduplicam por ID e usam sequência/versão para não regredir projeções. Não prometer ordem global nem exatamente uma entrega. Wallets distintas não compartilham lock de publicação. Falha permanente que bloqueie sequência deve ser visível e ter procedimento documentado de reenvio após correção, sem editar o evento financeiro.

### Observabilidade, console e entrega

**R/A:** logs JSON com identificadores aplicáveis, sem segredos nem payload completo; Prometheus/Grafana provisionados, métricas de status, duplicatas, retries, DLQ, locks, latência e outbox lag. Separar tentativas de resultados financeiros únicos. Labels têm cardinalidade limitada; IDs ficam nos logs. Banco fornece contagens financeiras duráveis; métricas de processo podem reiniciar e não são fonte de saldo.

**A:** console apresenta wallets, transações, ledger, reconciliação e cenários reais de demonstração. Estados pendentes são acompanhados por GET; exibir recibo original e estado atual sem confundi-los. Falhas/restrições são aplicadas no backend, não só nos botões. Valores exibidos preservam strings decimais. O design e stack específicos do frontend serão escolhidos na etapa de implementação, respeitando contratos e perfis, sem alterar o núcleo financeiro.

Cenários incluem disputa de saldo, duplicatas e reversão fora de ordem. Injeção de morte de processo fica no harness de testes/demonstração controlada, não em endpoint público que aceite comando arbitrário. Listagens usam dados reais e estados de carregamento, vazio e erro.

**A:** entrega inclui Compose reproduzível, documentação de setup e arquitetura, teste de carga, demonstração HTTPS autenticada e vídeo curto. Infraestrutura administrativa não é pública. Dados e credenciais de testes, demonstração local e hospedagem são isolados. Hospedagem/custo/acesso externo serão definidos antes do deploy, sem compromisso financeiro implícito. O repositório é privado durante o desenvolvimento; acesso dos avaliadores é parte da checklist de entrega. Não enviar PR ao repositório do desafio sem solicitação.

## Testing Decisions

As interfaces foram aprovadas no grill: domínio público, HTTP/Keycloak, SQS, schema SQL, aplicação multiprocesso e frontend no navegador. Não há testes existentes para reutilizar. Bun é o runner; automação de navegador pode ser acionada pela biblioteca de controle de browser dentro do harness Bun, sem substituir o runner obrigatório.

Testes observam comportamento por essas interfaces. SQL direto é intencional nos testes de constraints. Não testar métodos privados ou mocks que apenas espelham a implementação. Ciclos incrementais de teste falhando → implementação → verificação. Infraestrutura real e eventos de coordenação tornam corridas e crashes reproduzíveis; relógio controlável nas políticas de tempo sem sleeps longos arbitrários.

### Matriz de requisitos e evidências

A matriz abaixo define a evidência exigida para a entrega completa. Evidências executadas do recorte #3: [relatório e screenshots](evidence/issue-3/README.md). Requisitos de wagering, workers e reconciliação ainda não estão concluídos.

| ID | Origem | Critério de aceite / decisão | Teste e evidência exigidos |
| --- | --- | --- | --- |
| R01 | §4 | Bun 1.x, TS strict, NestJS, PostgreSQL, MikroORM, SQS e Compose | Bootstrap limpo, versões fixadas, build e typecheck. |
| R02 | §4 | Migrations reversíveis | Up/down/up em banco descartável com constraints revalidadas. |
| R03 | §6.0 | Factories e rehydrate, estado encapsulado | Testes públicos e revisão de dependências do domínio. |
| R04 | §§5,6.1 | Dinheiro exato, escala, negativos de entrada, valores inválidos e moedas | Unidade e SQL: limite, overflow, 0.001, NaN/Infinity/expoente, imutabilidade e moedas divergentes. |
| R05 | §§6.2,9 | Wallet única, version=1, abertura contabilizada | API e SQL para abertura positiva/zero, duplicação e tentativa de saldo sem journal. |
| R06 | §7 | BET/WIN/LOSS corretos | Exemplos independentes de saldo, eventos, versão e ledger; WIN não exige valor igual à BET. |
| R07 | §7 | Reversões integrais e vínculos válidos | REFUND/ROLLBACK de cada tipo permitido, negativos, referências incompatíveis e reversão repetida. |
| R08 | §6.3 | Estados terminais imutáveis; OPENING interno | Unidade, API, SQS e tentativas SQL inválidas. |
| R09 | §§7,9 | Idempotência persistente e hash canônico | Ordem de chaves diferente, payload divergente, mesma operação com nova chave, escopo por provedor e HTTP/SQS cruzados. |
| R10 | §§7,9 | Recibo original e saldo histórico | Replay após outras movimentações, pendência concluída e reinício. |
| R11 | §7.1 | Referências fora de ordem e TTL | REFUND e ROLLBACK antes da origem; WIN opcional; expiração, referência terminal e indisponibilidade. |
| R12 | §8 | Duas BET 80.00 sobre 100.00 | Exatamente uma PROCESSED, outra REJECTED, saldo 20.00 e um débito na wallet. |
| R13 | §13.1 concorrência | Mesma aposta 50 vezes em paralelo | Um débito, uma transação e eventos únicos, conferidos após entrega real à aplicação. |
| R14 | §§8,13 | Pelo menos três processos; wallets independentes | Corridas HTTP/SQS multiprocesso, evidência de paralelismo sem lock global. |
| R15 | §§5,6.4 | Ledger imutável e saldo consistente | SQL tenta UPDATE/DELETE/TRUNCATE, journal órfão e moeda divergente; reconciliação final. |
| R16 | §§6.5,11 | Atomicidade de wallet, ledger, transação, inbox, recibo e outbox | Falha em cada etapa antes do commit deixa zero efeitos parciais; commit confirma conjunto completo. |
| R17 | §10 | Inbox e ack após commit | Matar worker após commit antes de ack; redelivery preserva resultado e não duplica débito. |
| R18 | §10 | Retry, DLQ e shutdown | Indisponibilidade temporária, poison message, maxReceiveCount, falha entre DLQ send/delete e SIGTERM. |
| R19 | §11 | Publishers concorrentes e recuperação | Dois publishers, morte após commit e após envio antes de confirmação, lease expirado e consumidor deduplicando. |
| R20 | §11 | Eventos mínimos e envelope em classes | Contratos de envelope, causação/correlação, MoneyProps, LOSS e ausência de evento de saldo sem mudança. |
| R21 | §9 | Todos os endpoints e paginação | Contratos, limites de cursor, páginas sem repetição/lacunas durante inserções e códigos HTTP. |
| R22 | §9 | Reconciliação sem correção silenciosa | Snapshot consistente sob carga; divergência injetada só em fixture privilegiada de banco descartável, com resposta/log/métrica. |
| R23 | §12 | Logs, métricas, health | Asserções de campos/redação, falhas de readiness, coleta multiprocesso e dashboard real. |
| R24 | §13.8 | Reinício e consistência final | Reiniciar serviços, drenar pendências e reconstruir todas as wallets pelo ledger. |
| R25 | §14 | Documentação reproduzível | Execução desde checkout limpo por roteiro e relatório de limitações. |
| D01 | §6.4 + A | Partidas dobradas | Pares balanceados, contrapartidas distintas, proteção SQL e nenhuma serialização global. |
| D02 | §2 + A | Keycloak e perfis | 401/403, token de outro provedor, ownership de consultas, viewer sem escrita, demo isolada. |
| D03 | A | Console | Browser: login, permissões, cenário completo, recibo versus estado atual e reconciliação. |
| D04 | §14 + A | Teste de carga | bun run test:load, 3 cenários, uma/três instâncias, ambiente, throughput, p50/p95/p99, erros, locks, lag e limitações do gerador. |
| D05 | A | Hospedagem e vídeo | HTTPS/login, acesso do avaliador, dados fictícios e vídeo de disputa/replay/recuperação. |

### Critério de conclusão

Todos os requisitos R01–R25 e diferenciais D01–D05 demonstrados, sem falha eliminatória. Testes passando, typecheck/build válidos, ambiente limpo reproduzido, matriz preenchida com evidências reais e limitações honestas. Cobertura numérica não substitui cenários. Carga inclui aquecimento, taxa oferecida e processada, rejeições separadas de erros, reconciliação e balanceamento final. Nenhum ganho linear presumido.

## Out of Scope

Integração de pagamentos externos, depósitos/saques reais, OAuth artesanal, produção com dinheiro real, microserviços com bancos independentes, Kubernetes, plataforma de provisionamento de sandboxes, reversões parciais, conversão cambial, regras adicionais de rodada não solicitadas e OpenTelemetry nesta entrega. Dados multimoeda são suportados no modelo; habilitação operacional além de BRL é extensão.

## Further Notes

As interpretações mais sensíveis são explícitas: REFUND + ROLLBACK da mesma BET por tipos distintos; recibo pendente estável; WIN com referência exige BET processada; tratamento de zero e referência opcional de LOSS detalhados aqui. Estas duas últimas são decisões técnicas desta spec, não votos do grill. Se contradisserem esclarecimento posterior da Jungle, revisar antes da implementação correspondente.

Plano subsequente: tickets verticais com critérios ligados aos IDs da matriz, dependências explícitas e demonstração/teste por entrega. Bootstrap inclui smoke de infraestrutura; primeira entrega financeira fecha abertura/BET/ledger/idempotência/concorrência. Não criar todos os testes ou todas as camadas isoladamente antes do primeiro fluxo completo.

Referências primárias: [README](https://github.com/junglegaming/backend-challenge), [PostgreSQL NUMERIC](https://www.postgresql.org/docs/current/datatype-numeric.html), [constraint triggers](https://www.postgresql.org/docs/current/sql-createtrigger.html), [locks](https://www.postgresql.org/docs/current/explicit-locking.html), [MikroORM context](https://mikro-orm.io/docs/identity-map), [decimal.js](https://mikemcl.github.io/decimal.js/), [AWS outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html), [SQS DLQ](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html), [SQS visibility](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests), [Keycloak](https://www.keycloak.org/securing-apps/javascript-adapter), [TigerBeetle accounting](https://docs.tigerbeetle.com/coding/financial-accounting/), [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html). Referências fundamentam mecanismos, sem substituir regras específicas do desafio.
