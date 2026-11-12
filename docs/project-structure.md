# Organização do projeto

Estrutura aprovada no grill em 2026-11-11, adaptada à referência de pastas fornecida pelo usuário. Criar diretórios conforme forem necessários, sem scaffolding vazio.

```text
src/
  bootstrap/                   # Inicialização de API e workers
  config/                      # Ambiente e configuração
  modules/
    wagering/
      domain/
        entities/
        events/
        errors/
      application/
        use-cases/
        ports/
      infrastructure/
        persistence/
          entities/            # Mapeamentos MikroORM
          repositories/
          mappers/
        broker/
          consumers/
      rest/
        controllers/
        dtos/
      scheduler/               # Referências pendentes
    wallets/                   # Wallets, ledger e reconciliação
    identity/                  # Guards e identidade de provedores
    demo/                      # Cenários autorizados
  messaging/                   # Infraestrutura comum de inbox/outbox/SQS
  observability/               # Logs, métricas e health
  shared/
    domain/                    # Money e poucos conceitos comuns
migrations/
tests/
  unit/
  integration/
  concurrency/
  load/
frontend/
infra/                         # Keycloak, filas e Grafana
docs/
Dockerfile
compose.yaml
.env.example
```

O domínio não depende de entidades de persistência ou decorators do ORM. Os nomes familiares da referência (controllers, DTOs, consumers, repositories e mappers) ficam próximos do módulo que os utiliza. Evitar serviços e utilitários globais que concentrem regras sem responsabilidade definida.

O caso de uso financeiro coordena alterações de wallet, ledger, transação, inbox aplicável e outbox na mesma transação SQL. Módulos não confirmam independentemente parcelas dessa operação. A infraestrutura de messaging não recebe responsabilidade sobre regras financeiras.

O escopo dos testes está em testing-strategy.md. Referências: [README](https://github.com/junglegaming/backend-challenge) e ADR 0016.
