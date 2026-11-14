// Narration for the demo video (pt-BR). Each line is synthesized separately so the recorder can pace
// every scene to its own audio. `speech` is what the voice reads; `caption` is the on-screen subtitle.
export interface NarrationLine {
  id: string;
  caption: string;
  speech?: string;
}

export const narration: readonly NarrationLine[] = [
  {
    id: 'intro',
    caption:
      'Este é o Lastro, o console de prova do processador de apostas que construímos para o desafio de backend.',
  },
  {
    id: 'stack',
    caption:
      'Tudo roda no stack local real: API, workers, PostgreSQL, SQS e Keycloak. O health check confirma banco e fila prontos.',
    speech:
      'Tudo roda no stack local real: API, workers, Postgres, S Q S e Keycloak. O health check confirma banco e fila prontos.',
  },
  {
    id: 'login',
    caption:
      'Entramos pelo Keycloak com Authorization Code e PKCE, como demo-operator, o perfil que cria wallets e executa as provas.',
    speech:
      'Entramos pelo Keycloak com Authorization Code e P K C E, como demo operator, o perfil que cria wallets e executa as provas.',
  },
  {
    id: 'wallet',
    caption:
      'Criamos uma wallet fictícia com R$ 100,00. O saldo inicial entra no ledger como lançamento de abertura.',
    speech:
      'Criamos uma wallet fictícia com cem reais. O saldo inicial entra no ledger como lançamento de abertura.',
  },
  {
    id: 'race-intro',
    caption:
      'Prova 1: o saldo nunca fica negativo. Duas apostas de 80% do saldo chegam ao mesmo tempo, com chaves diferentes.',
    speech:
      'Prova um: o saldo nunca fica negativo. Duas apostas de oitenta por cento do saldo chegam ao mesmo tempo, com chaves diferentes. Só uma pode caber.',
  },
  {
    id: 'race-result',
    caption:
      'Uma foi aceita com HTTP 200; a outra, recusada por saldo insuficiente. Um único débito: o saldo terminou em R$ 20,00.',
    speech:
      'Uma foi aceita, com HTTP duzentos. A outra foi recusada por saldo insuficiente. Houve um único débito, e o saldo terminou em vinte reais.',
  },
  {
    id: 'ticket',
    caption:
      'Cada operação vira um bilhete: o recibo original fica no canhoto; o estado atual, consultado por GET, na via de validação.',
    speech:
      'Cada operação vira um bilhete. O recibo original, imutável, fica no canhoto. O estado atual, consultado por GET, fica na via de validação.',
  },
  {
    id: 'duplicate-intro',
    caption:
      'Prova 2: idempotência. A mesma aposta é enviada duas vezes em paralelo, com a mesma chave.',
    speech:
      'Prova dois: idempotência. A mesma aposta é enviada duas vezes em paralelo, com a mesma chave.',
  },
  {
    id: 'duplicate-result',
    caption:
      'As duas respostas apontam para a mesma transação, e o segundo recibo é um replay. O débito aconteceu uma vez só.',
  },
  {
    id: 'order-intro',
    caption: 'Prova 3: um estorno que chega antes da aposta que ele referencia.',
    speech: 'Prova três: um estorno que chega antes da aposta que ele referencia.',
  },
  {
    id: 'order-result',
    caption:
      'O canhoto guarda o aceite original: 202, aguardando referência. A validação mostra que ele foi processado quando a aposta chegou.',
    speech:
      'O canhoto guarda o aceite original: duzentos e dois, aguardando referência. A validação mostra que ele foi processado quando a aposta chegou, e o console destaca que o estado mudou desde o aceite.',
  },
  {
    id: 'recovery-intro',
    caption:
      'Prova 4: falha de processo. No terminal, derrubamos o worker de referências com SIGKILL.',
    speech:
      'Prova quatro: falha de processo. No terminal, derrubamos o worker de referências com sig kill.',
  },
  {
    id: 'recovery-pending',
    caption:
      'Sem o worker, o estorno fica pendente, e o cronômetro mostra há quanto tempo. A agenda de novas tentativas está no PostgreSQL, não na memória.',
    speech:
      'Executamos a mesma situação. Sem o worker, o estorno fica pendente, e o cronômetro mostra há quanto tempo. A agenda de novas tentativas está no Postgres, não na memória do processo.',
  },
  {
    id: 'recovery-restart',
    caption: 'Subimos o worker de novo.',
  },
  {
    id: 'recovery-result',
    caption:
      'Ele retoma o trabalho pendente e processa o estorno. A prova só vale porque a pendência durou mais que o ciclo normal do worker.',
    speech:
      'Ele retoma o trabalho pendente e processa o estorno. Nada se perdeu na queda. E a prova só vale porque a pendência durou mais que o ciclo normal do worker.',
  },
  {
    id: 'sqs-intro',
    caption:
      'O mesmo vale para a fila: derrubamos o consumidor de comandos e publicamos uma aposta de R$ 10,00 direto no SQS.',
    speech:
      'O mesmo vale para a fila. Derrubamos o consumidor de comandos e publicamos uma aposta de dez reais direto no S Q S.',
  },
  {
    id: 'sqs-result',
    caption: 'A mensagem espera na fila. Quando o consumidor volta, a aposta é processada.',
  },
  {
    id: 'sqs-redelivery',
    caption:
      'Reenviamos a mesma operação com outro messageId: a inbox e a idempotência persistentes não repetem o débito.',
    speech:
      'Reenviamos a mesma operação, com outro identificador de mensagem. A inbox e a idempotência persistentes não repetem o débito.',
  },
  {
    id: 'ledger',
    caption:
      'No ledger, um único lançamento de R$ 10,00, e o saldo corrente fecha com o saldo da wallet.',
    speech:
      'No ledger, há um único lançamento de dez reais, e o saldo corrente fecha com o saldo da wallet.',
  },
  {
    id: 'reconcile-intro',
    caption:
      'Prova 5: reconciliação. O servidor reconstrói o saldo somando o ledger imutável e compara com o saldo registrado.',
    speech:
      'Prova cinco: reconciliação. O servidor reconstrói o saldo somando o ledger imutável, e compara com o saldo registrado.',
  },
  {
    id: 'reconcile-result',
    caption:
      'Registrado e reconstruído são iguais, diferença zero. Cinco de cinco garantias mantidas, com os dados desta execução.',
  },
  {
    id: 'outro',
    caption:
      'A morte do processo entre o commit e o ack é provada pelos testes automatizados de recuperação. Código, arquitetura e testes estão no repositório.',
    speech:
      'Os cenários mais difíceis de encenar, como a morte do processo entre o commit e o ack, são provados pelos testes automatizados de recuperação. Código, arquitetura e testes estão no repositório.',
  },
];
