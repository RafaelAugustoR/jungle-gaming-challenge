# Plano de tickets — aprovado e publicado

Fonte: [Spec #1](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/1). Recorte aprovado pelo usuário e publicado em 2026-11-12. Números das seções são identificadores de planejamento; a tabela abaixo fornece os números reais das Issues. Todas receberam ready-for-agent e os 22 bloqueios foram registrados como dependências nativas no GitHub.

| Plano | Issue | Bloqueada por Issues |
| --- | --- | --- |
| T01 | [#2](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/2) | Nenhum |
| T02 | [#3](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/3) | #2 |
| T03 | [#4](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/4) | #3 |
| T04 | [#5](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/5) | #4 |
| T05 | [#6](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/6) | #5 |
| T06 | [#7](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/7) | #4 |
| T07 | [#8](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/8) | #4 |
| T08 | [#9](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/9) | #4 |
| T09 | [#10](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/10) | #6, #7, #8, #9 |
| T10 | [#11](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/11) | #6, #7, #8 |
| T11 | [#12](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/12) | #6, #7, #8, #9 |
| T12 | [#13](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/13) | #11, #12 |
| T13 | [#14](https://github.com/RafaelAugustoR/jungle-gaming-challenge/issues/14) | #10, #13 |

Cada entrega inclui implementação, testes e documentação do próprio comportamento. Logs, autorização, constraints e eventos entram junto do fluxo correspondente; os tickets de observabilidade e recuperação consolidam evidências, não adiam essas garantias. Interface financeira pode ser verificada por API/fila antes de ganhar sua apresentação completa no console.

## 1. Subir ambiente reproduzível e verificar dependências

**Parent:** Spec #1

**Blocked by:** Nenhum

**Requisitos:** R01, R02, R23, R25

**What to build:** Um avaliador sobe a aplicação e verifica que banco e fila realmente estão acessíveis.

**Acceptance criteria:**

- [ ] Fixar versões compatíveis de Bun, NestJS, MikroORM e imagens; escolher emulador SQS e justificar com smoke real.
- [ ] Compose inicia PostgreSQL, SQS e Keycloak; API expõe liveness/readiness com falhas verificáveis de dependências.
- [ ] Executar migration up/down/up em banco descartável e smoke de envio/recebimento SQS.
- [ ] Build, typecheck, bun test e CI mínima funcionam; documentar comandos realmente executados.

## 2. Criar e consultar wallet autenticada com abertura contabilizada

**Parent:** Spec #1

**Blocked by:** 1

**Requisitos:** R03, R04, R05, R15, R16, D01, D02, D03

**What to build:** Um demo-operator entra no console, cria uma wallet e consulta seu saldo e lançamento de abertura.

**Acceptance criteria:**

- [ ] Configurar Keycloak, três perfis humanos e dois provedores; frontend faz login PKCE e backend verifica tokens/roles.
- [ ] Implementar Money exato, conta do jogador, contrapartida de abertura, journal balanceado e wallet; abertura positiva/zero e versão inicial seguem a spec.
- [ ] POST/GET de wallet e tela mínima de criação/consulta usam dados reais; viewer não escreve.
- [ ] Migrations e testes SQL impedem duplicação, valores inválidos, ledger mutável e saldo positivo sem journal; teste de atomicidade inclui outbox aplicável.
- [ ] Testar factories/rehydrate, moeda divergente, overflow e precisão; usuário runtime não tem privilégios de migration.

## 3. Processar BET idempotente sob concorrência via HTTP

**Parent:** Spec #1

**Blocked by:** 2

**Requisitos:** R06, R08, R09, R10, R12, R13, R14, R16, R20, R21, D02

**What to build:** Um provedor aposta, repete a chamada e disputa saldo sem produzir débito duplicado.

**Acceptance criteria:**

- [ ] Implementar caso de uso compartilhável, lock por wallet, transação, journal, recibo e eventos tipados na outbox atômicos; nenhuma publicação antecipada.
- [ ] Validar identidade autenticada do provedor, wallet/jogador/moeda e OPENING externo; consultas por ID interno/externo respeitam ownership.
- [ ] Testar hash canônico, escopo por provedor, chave divergente e nova chave para mesma operação; replay mantém saldo histórico e 422 original.
- [ ] Com três processos, cinquenta submissões geram um débito; duas BET 80 sobre 100 resultam em saldo 20, uma aprovada e outra rejeitada.
- [ ] Wallets distintas avançam independentemente; contratos de erro, zero, estados terminais e incremento de versão têm testes.

## 4. Liquidar WIN/LOSS e aplicar reversões com referência disponível

**Parent:** Spec #1

**Blocked by:** 3

**Requisitos:** R06, R07, R08, R20

**What to build:** O provedor conclui operações e aplica REFUND/ROLLBACK com trilha financeira auditável.

**Acceptance criteria:**

- [ ] Adicionar WIN sem referência ou com BET válida, LOSS e todas as referências permitidas de REFUND/ROLLBACK.
- [ ] Validar tipo, vínculos, estado, valor de reversão e saldo; distinguir INSUFFICIENT_FUNDS de REVERSAL_INSUFFICIENT_FUNDS.
- [ ] Unicidade persistente por referência/tipo impede duas reversões aplicadas iguais, inclusive concorrentes; testar sequência aprovada 100→80→100→120.
- [ ] LOSS, rejeições e valor zero não mudam saldo/versão nem criam journal; eventos, recibos e consultas refletem cada resultado.
- [ ] Referência terminal/incompatível falha explicitamente; casos dependentes de referência ausente são entregues no ticket 5.

## 5. Resolver referências fora de ordem e expiração

**Parent:** Spec #1

**Blocked by:** 4

**Requisitos:** R08, R10, R11, R16, R20, R24

**What to build:** Uma reversão antecipada fica pendente e depois é aplicada ou rejeitada por uma causa verificável.

**Acceptance criteria:**

- [ ] Persistir PENDING_REFERENCE, deadline e próxima tentativa; worker separado com backoff, jitter e TTL configurável.
- [ ] Testar REFUND/ROLLBACK antes da referência, WIN/LOSS com referência opcional, autorreferência e estados terminais.
- [ ] Arbitrar processamento/expiração sob lock conforme spec; falha de infraestrutura não vira referência inexistente.
- [ ] Reinício preserva agenda; múltiplos workers não duplicam efeitos/eventos; retry ainda pendente não emite novo evento de entrada.
- [ ] Replay mantém 202 original enquanto GET mostra resultado atual; relógio controlado cobre TTL sem esperar quinze minutos.

## 6. Consumir operações SQS com inbox, DLQ e shutdown seguro

**Parent:** Spec #1

**Blocked by:** 3

**Requisitos:** R09, R16, R17, R18

**What to build:** Uma operação enviada pela fila usa o mesmo processamento HTTP e sobrevive a redelivery.

**Acceptance criteria:**

- [ ] Provisionar filas obrigatórias e consumir envelope com providerId validado, inbox persistente e ack só após commit.
- [ ] Testar duplicatas que atravessam a deduplicação FIFO, conflitos de messageId/payload e idempotência cruzada HTTP/SQS.
- [ ] Implementar retry transitório, maxReceiveCount=5 e envio seguro de inválidas à DLQ; não perder origem se destino falhar.
- [ ] SIGTERM para polling e drena/cancela antes de devolver visibilidade; testes cobrem morte pós-commit/pré-ack e falha entre envio à DLQ e delete.
- [ ] Aceitar pendência persistida e confirmar mensagem sem esperar referência; validar integração com ticket 5 no teste completo do ticket 11.

## 7. Publicar eventos confirmados com recuperação e deduplicação

**Parent:** Spec #1

**Blocked by:** 3

**Requisitos:** R19, R20, R24

**What to build:** Um consumidor observa eventos financeiros mesmo quando o publisher morre e outro assume.

**Acceptance criteria:**

- [ ] Provisionar fila de eventos separada e consumidor demonstrativo com deduplicação persistente.
- [ ] Implementar reservas com SKIP LOCKED, expiração, token de posse e publicação fora da transação financeira.
- [ ] Preservar eventId, sequência por wallet e primeiro evento pendente; replicação não regride projeções nem cria efeitos duplicados.
- [ ] Testar dois publishers, crash antes de publicar/depois de enviar, reserva expirada e confirmação por proprietário antigo.
- [ ] Falhas usam backoff; evento permanentemente problemático permanece retido e diagnosticável, com procedimento de recuperação.

## 8. Consultar ledger e reconciliar pelo console

**Parent:** Spec #1

**Blocked by:** 3

**Requisitos:** R15, R21, R22, D01, D02, D03

**What to build:** Um operador navega pelo histórico e compara saldo materializado com o reconstruído.

**Acceptance criteria:**

- [ ] Implementar ledger com cursor opaco estável, limite e teto capturado; sem lacunas/duplicação durante novas operações.
- [ ] Reconciliar sob snapshot consistente e expor contagens, saldos e diferença exata sem corrigir dados.
- [ ] Console exibe partidas da wallet, referência da operação e resultado de reconciliação; viewer consulta, operator reconcilia.
- [ ] Teste de divergência usa fixture privilegiada isolada e verifica resposta, log e métrica.
- [ ] Verificar proteção contra ledger órfão, inconsistência de versão e contrapartida global serializante.

## 9. Demonstrar ciclo financeiro completo no console

**Parent:** Spec #1

**Blocked by:** 5, 6, 7, 8

**Requisitos:** R10, R21, D02, D03

**What to build:** O avaliador acompanha transações e dispara cenários reais de duplicação, disputa e referência atrasada.

**Acceptance criteria:**

- [ ] Listar e consultar transações com filtros e distinguir recibo original de estado atual; valores financeiros permanecem exatos.
- [ ] Demo-operator dispara cenários usando identidade do provedor no servidor, com auditoria do ator e resultados reais.
- [ ] Integrar consultas de wallet/ledger/reconciliação e acompanhar conclusão pelo GET; permissões são verificadas no backend.
- [ ] Browser cobre login, perfil sem permissão, fluxo completo e estados de carregamento/vazio/erro; verificar layout responsivo e acessibilidade básica.
- [ ] Não expor execução arbitrária ou encerramento de processo em endpoints públicos; falhas destrutivas ficam no harness controlado.

## 10. Diagnosticar processamento com métricas e Grafana

**Parent:** Spec #1

**Blocked by:** 5, 6, 7

**Requisitos:** R23

**What to build:** O operador identifica atrasos, retries, DLQ e contenção usando dados reais do sistema.

**Acceptance criteria:**

- [ ] Completar logs correlacionados sem segredos/payload financeiro completo; validar redação e campos aplicáveis.
- [ ] Consolidar instrumentação introduzida em cada fluxo: status, duplicatas, retries, DLQ, locks, lag e latência; labels limitadas.
- [ ] Prometheus coleta múltiplos processos; contagens duráveis de negócio não se confundem com tentativas nem reinícios.
- [ ] Grafana provisionado mostra carga e falhas reais; métricas/admin restritos e health público conforme contrato.
- [ ] Documentar diagnóstico e validar métricas durante indisponibilidade e recuperação.

## 11. Comprovar recuperação integrada com três instâncias

**Parent:** Spec #1

**Blocked by:** 5, 6, 7, 8

**Requisitos:** R02, R12, R13, R14, R16, R17, R18, R19, R24

**What to build:** O avaliador executa um roteiro determinístico de falhas e obtém consistência financeira ao final.

**Acceptance criteria:**

- [ ] Reunir testes já entregues em harness multiprocesso com barreiras/failpoints controlados; não substituir PostgreSQL/SQS por mocks.
- [ ] Cobrir cinquenta duplicatas, disputa de saldo, wallets independentes, dois publishers e entradas HTTP/SQS concorrentes.
- [ ] Matar worker pós-commit/pré-ack, reiniciar processos, simular dependências indisponíveis e resolver referências fora de ordem pela fila.
- [ ] Reconciliar todas as wallets e verificar balanceamento, eventos e ausência de efeitos parciais após recuperação.
- [ ] Executar migrations completas up/down/up e cenários de constraints em ambiente descartável; registrar evidências e corrigir falhas encontradas.

## 12. Medir carga e documentar limites

**Parent:** Spec #1

**Blocked by:** 10, 11

**Requisitos:** D04

**What to build:** O avaliador compara uma e três instâncias com metodologia reproduzível e invariantes verificadas.

**Acceptance criteria:**

- [ ] Disponibilizar bun run test:load com aquecimento, taxa e duração configuráveis e dados reproduzíveis.
- [ ] Executar hot wallet, wallets distribuídas e duplicatas para uma/três instâncias, distribuindo tráfego de forma documentada.
- [ ] Registrar ambiente, throughput oferecido/processado, p50/p95/p99, erros, rejeições, locks, outbox lag e limitações do gerador.
- [ ] Reconciliar após cada execução, preservar resultados brutos e explicar gargalos sem inventar meta ou ganho linear.

## 13. Publicar demonstração e concluir entrega reproduzível

**Parent:** Spec #1

**Blocked by:** 9, 12

**Requisitos:** R25, D05

**What to build:** O avaliador acessa uma demonstração autenticada, vê o vídeo e reproduz tudo localmente.

**Acceptance criteria:**

- [ ] Concluir README/ARCHITECTURE, matriz de evidências, roteiro, limitations e revisão contra todas as falhas eliminatórias.
- [ ] Validar checkout limpo com build, typecheck e suítes completas; revisão de código/spec e correções antes da entrega.
- [ ] Definir destino/custo/acesso antes do deploy; publicar HTTPS com dados fictícios e administração/banco/filas não públicos.
- [ ] Gravar vídeo de disputa, replay, falha/recuperação e reconciliação com dados da execução.
- [ ] Garantir acesso dos avaliadores ao repositório e preparar pacote/link para o portal; não enviar mensagens ou submissão externa sem instrução explícita.

## Publicação

Tamanho das entregas e dependências aprovados. Issues #2–#14 publicadas com critérios completos e referência à Spec #1, sem modificar ou encerrar a Issue pai. A primeira entrega liberada é #2; as demais aguardam seus bloqueios. Nenhuma implementação foi concluída nesta etapa.
