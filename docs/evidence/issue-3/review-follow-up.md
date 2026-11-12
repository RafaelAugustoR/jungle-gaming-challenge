# Revisão do PR #16

Base da revisão: `5aec466`; escopo continua sendo Issue #3 / T02. Avaliados os 12 comentários contra a spec, o README do desafio e as ADRs 0005, 0012, 0015 e 0016. Todos os apontamentos foram acolhidos, com as distinções de escopo abaixo.

| Comentário | Avaliação e correção |
| --- | --- |
| 4554613005 — tabela de transações | OPENING é um tipo de transação. Migration 0003 renomeia a tabela, preserva linhas/FKs/permissões e permite tipos/estados comuns. Unicidade de abertura passa a índice parcial. |
| 4554613014 — cadeia e versão | Validação incremental genérica por predecessor/sucessor e último journal; base sem lançamentos é saldo 0/versão 1. OPENING mantém sua exceção de versão inicial. Funções ativas não fazem dispatch por nome da tabela. |
| 4554613021 — JSON em trigger | Trigger exige o evento pela relação transação/wallet/tipo. Contrato e versão do payload ficam no evento de domínio e nos testes; não há to_char ou inspeção de dados financeiros JSON na validação ativa. |
| 4554613028 — ledger | View deriva kind da transação e direção da participação da conta do jogador. Teste SQL cobre crédito, débito e nova versão. |
| 4554613036 — caso de uso | Parsing/serialização em REST; comando tipado e porta WalletStore no caso de uso; SQL no adaptador; filtro REST global único. A criação de wallet continua sendo um comando humano, não uma mensagem SQS. O compartilhamento HTTP/SQS de apostas continua em T03/T06. |
| 4554613044 — códigos de erro | DomainError tem união de códigos; erros desconhecidos permanecem 500 INTERNAL_ERROR, sem copiar message para code. |
| 4554613061 — abertura | Wallet.open produz o conjunto financeiro e WalletBalanceChanged.from deriva os dados do lançamento. INSERT do journal usa todos os campos da entry, sem repetir saldo/versão em literais. |
| 4554613069 — precisão | Só Money importa decimal.js; rehydrate aceita NUMERIC assinado com escala 0–2 e normaliza sem arredondar. Entrada HTTP continua exigindo duas casas não negativas. |
| 4554613074 — unicidade | Apenas wallets_player_id_currency_key é conflito de wallet. Violação de outra constraint não vira 409 de negócio. |
| 4554613080 — factories/rehydrate | Regras de abertura/criação nas factories; rehydrate reconstrói fatos persistidos. Wallet guarda e expõe Money e versão. |
| 4554613091 — direção | Não existe direction independente na entrada da factory; ela é derivada da conta do jogador no par contábil. |
| 4554613097 — identidade | Principal é união discriminada human/provider. Clientes/provedores vêm de configuração validada, com teste de binding de IDs diferentes. |

A migration inicial é mantida como histórico; a evolução está em 0003 para não apagar dados de quem já executou o PR. Downgrade rejeita dados de jogos em vez de descartá-los. Regras de transição/idempotência de apostas, processamento SQS e publicação da outbox permanecem nos tickets planejados.

Validação por interfaces aprovadas: métodos públicos de domínio; HTTP/JWT/Keycloak; constraints e migrations em PostgreSQL real; cenário existente no navegador. Resultado final e CI serão registrados no PR após execução.

Revisão adicional (Standards/Spec): corrigida a coordenação financeira para que `Wallets.create` invoque `Wallet.open` dentro da sessão transacional e persista o resultado pela porta. Também adicionada a proteção SQL contra direção invertida de BET/WIN/REFUND, com regressão que falhou antes da correção. Nenhum apontamento desta revisão permanece pendente.

Validação final local: `bun run build`, checagem de formatação dos arquivos alterados, `git diff --check` e `INTEGRATION=1 BROWSER=1 CHROME_PATH=/usr/bin/google-chrome bun test` com URLs de runtime/migration distintas. **42 pass, 0 fail, 226 expect() calls, 13 arquivos, 14.87 s.** PostgreSQL, SQS, Keycloak e navegador reais; API reconstruída via Compose. A migration foi exercitada em bancos descartáveis, inclusive up/down/up e preservação de abertura prévia.
