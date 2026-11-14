# Pacote de entrega

Este é o material para a submissão ao processo da Jungle Gaming. **Nada foi enviado.** O
repositório continua privado, ninguém foi convidado e o portal não recebeu submissão. Cada ação
externa abaixo depende de autorização explícita.

## Situação do acesso (verificada em 2026-11-14)

| Item | Situação | Pendência |
| --- | --- | --- |
| Repositório `RafaelAugustoR/jungle-gaming-challenge` | **Privado**; único colaborador é o dono | Decidir entre convidar os avaliadores (usuários do GitHub informados pela Jungle) ou tornar o repositório público na data da entrega |
| Demonstração hospedada | Configuração pronta e testada localmente com HTTPS; **não publicada** | Escolher o provedor/VM, o domínio (dois hostnames), o orçamento e o canal privado das senhas; depois publicar seguindo [deploy/hosted](../deploy/hosted/README.md) |
| Vídeo | Gravado a partir do roteiro, com dados reais ([evidence/issue-14](evidence/issue-14/README.md#vídeo)); versionado só no repositório privado | Decidir a forma de disponibilizar (YouTube não listado, Drive com link ou anexo no portal) e se haverá narração em áudio |
| Portal da Jungle | Não submetido | Submeter quando os itens acima estiverem decididos |

## Links para a submissão

- Repositório: https://github.com/RafaelAugustoR/jungle-gaming-challenge (acesso conforme a decisão acima)
- Início rápido e roteiro de 5 minutos: [README.md](../README.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Matriz requisito → implementação → teste/evidência: [requirements-matrix.md](requirements-matrix.md)
- Evidências de carga: [issue-13](evidence/issue-13/README.md)
- Vídeo: _link a definir_
- Demonstração hospedada: _URL a definir_. Usuários `viewer`, `operator` e `demo-operator`, com
  senhas entregues por canal privado

## Texto sugerido para o portal

> Implementei o Distributed Wagering Processor em Bun 1.3.14, TypeScript strict, NestJS, MikroORM,
> PostgreSQL e SQS (LocalStack), com execução completa por Docker Compose.
>
> As garantias financeiras ficam no banco: Money exato (decimal.js e NUMERIC sem arredondamento),
> lock pessimista por wallet, unicidade de idempotência e de identidade externa, ledger de partidas
> dobradas imutável por trigger e cadeia saldo/ledger verificada no commit. HTTP e SQS usam o mesmo
> caso de uso; inbox, recibo, saldo, ledger e outbox são confirmados em uma única transação. Um
> worker resolve referências fora de ordem com TTL e backoff persistidos. A outbox usa leases com
> `SKIP LOCKED` e confirmação por posse.
>
> Os testes usam PostgreSQL, SQS e Keycloak reais e processos reais: 50 duplicatas em três APIs, a
> disputa 100→80+80, morte depois do commit e antes do ack, dois publishers, quedas isoladas de
> dependências e reconciliação de todas as wallets (`bun run test:recovery`). O teste de carga
> (`bun run test:load`) compara uma e três instâncias em três cenários e documenta os gargalos
> medidos, inclusive o limite atual de vazão da outbox.
>
> Diferenciais: Keycloak com perfis e identidades de máquina por provedor, console com recibo
> original × estado atual, Prometheus/Grafana, demonstração hospedada em HTTPS e vídeo.
>
> README: setup e comandos. ARCHITECTURE.md: decisões e limitações. docs/requirements-matrix.md:
> rastreabilidade de cada requisito.

## Checklist antes de submeter

- [ ] Autorizar e executar o acesso dos avaliadores ao repositório.
- [ ] (Opcional) Aprovar o destino e o custo da demo; publicar; rodar `test:stack` contra a URL
      pública; preencher a URL acima.
- [ ] Escolher onde hospedar o vídeo e preencher o link acima.
- [ ] Conferir se o CI do commit final está verde e se o PR da #14 foi mergeado.
- [ ] Submeter no portal (ação do autor).
