# Revisão da implementação — Issue #7

Base fixa: `main`, commit `890aed395397dfebf855d1de494988992500ec60`.
Primeira revisão: diff até `d73d781`, seguida de revisão da correção.

## Standards

Nenhuma violação documental bloqueante encontrada.

Duas observações de manutenção, por julgamento:

- Possível Duplicated Code nos provisionadores de comandos/eventos: ambos criam
  pares FIFO e configuram redrive. Mantidos como adaptadores curtos e independentes;
  nenhuma mudança no consumidor demonstrativo da #8 foi necessária.
- Wrappers genéricos `call<T>`/`send<T>` perdiam a relação de tipos do SDK. Corrigido:
  chamadas usam `sqs.send` diretamente; o helper monta apenas timeout/abort.

Total: zero violações documentadas; duas observações, uma corrigida e uma mantida.

## Spec

A primeira revisão identificou uma falha P1: renovações de visibilidade podiam
acumular quando SQS estivesse lento, ultrapassando o prazo de shutdown.

Corrigido com uma única chamada de renovação em andamento, cancelável pelo sinal
do processamento. Durante shutdown não se agenda backoff antes de devolver
visibilidade. Teste red/green usa proxy HTTP que represa ChangeMessageVisibility e
encaminha as demais operações ao LocalStack real; banco e fila continuam reais.
O teste red excedeu 10 s; o green passou em cerca de 0.5 s, com rollback da inbox.
A segunda revisão confirmou a correção e não identificou novos problemas.

Total inicial: um achado; total pendente após correção: zero.

## Comentários do revisor no PR #22

Os bloqueios estruturais foram incorporados: inbox insert-only ao final da transação,
erro próprio de messaging, decomposição do consumidor e classificação central por
categoria de erro, sem status HTTP no domínio. A precedência de diagnósticos de
validação/chave antes da inbox é explícita na spec; não muda aceitação financeira.

Também foram incorporados os ajustes de montagem compartilhada do caso de uso,
logs com os identificadores aplicáveis, reutilização de backoff, provisionamento,
URL/nome da DLQ e parsing de inteiros. O consumidor da #8 preserva sua projeção e
inbox próprias; compartilha somente os helpers de transporte/runtime.

Os dois follow-ups foram feitos neste PR: withBackendCancellation com comentário
sobre a corrida de registro do listener e divisão da suíte em cinco arquivos. A
fixture usa o provisionador real com RedrivePolicy. Produção e harness executam o
mesmo runCommandWorker e o mesmo tratamento de sinais do runtime compartilhado.
