# Processamento de apostas

Vocabulário dos participantes e das operações do processador de apostas.

## Participantes

**Viewer**:
Pessoa com permissão para consultar wallets, transações, ledger e métricas.

**Operator**:
Pessoa com as permissões de Viewer e autorização para executar reconciliação, sem corrigir saldo.

**Demo Operator**:
Pessoa com as permissões de Operator e autorização para criar wallets e disparar cenários no ambiente de demonstração.

**Provedor de jogos**:
Integração que envia operações de apostas identificadas por um providerId. Sua identidade é distinta da pessoa que inicia uma demonstração.
_Avoid_: Operador, provedor de pagamentos.

## Operações

**Conta de contrapartida**:
Conta que recebe a partida oposta à movimentação da conta do jogador. Contrapartidas de abertura e de operações de jogos distinguem a origem econômica dos lançamentos.

**Partidas dobradas**:
Registro de cada movimentação como débito e crédito de igual valor na mesma moeda, em contas distintas.

**Identidade externa da operação**:
Par formado por providerId e externalTransactionId que identifica uma operação de um provedor. Trocar a chave de idempotência não cria outra identidade externa.

**Replay idempotente**:
Repetição de uma submissão com a mesma chave e o mesmo conteúdo de negócio, sem repetir seus efeitos financeiros.

**Recibo de submissão**:
Resultado original devolvido ao aceitar uma operação, preservado para repetições idempotentes. Não representa necessariamente o estado atual de uma operação inicialmente pendente.

**Money**:
Valor monetário exato associado a uma moeda, com escala de duas casas decimais neste domínio. Valores de moedas diferentes não podem ser combinados em uma operação aritmética.

**Reconciliação**:
Verificação que compara o saldo registrado na wallet ao saldo reconstruído pelo ledger e sinaliza divergências, sem corrigi-las automaticamente.
