---
version: 1
slug: "frontend-index-html"
primary_target: "frontend/index.html"
related_targets: []
---

# Lastro · Console de prova

Escopo: console autenticado (entrada, provas guiadas, bilhetes da wallet, ledger, visão read-only). Modo: Operate.
Público: avaliador do desafio (ao vivo, hospedado e no vídeo 1280×800). Tarefa: provar 5 garantias com dados da execução.
Restrições: Preact + TSX empacotado pelo Bun; API, contratos e perfis inalterados; pt-BR; WCAG 2.2 AA; sem marca de terceiros.
Fora: explorador global de transações.
Aberto: nenhum.

## Direction contract

THESIS: Cada prova sai como um bilhete conferido. O recibo original fica no canhoto, o estado atual na via de validação, separados por um picote, e o veredito é um carimbo. Recusa o dashboard de cards de KPI e a tabela crua de recibos.

OWN-WORLD: Impressão de segurança de bilhete de loteria.
- Trilho em tinta violeta #24164F, fundo de papel de segurança lavanda, amarelo de bilhete para a prova ativa, verde que valida, vermelho que anula.
- Fios de 1px, cantos retos e marcas de estado em célula fixa: cheia mantida, vazada pendente, riscada violada.
- Archivo, cuja largura condensada vai nos carimbos e rótulos; mono só para IDs e serial.

STORY: o avaliador entra, cria uma wallet, roda as provas em sequência e lê "garantia mantida" com a evidência ao lado. Fecha com a reconciliação e um placar de 5/5.

FIRST VIEWPORT:
- Barra fina com o produto e o perfil.
- Trilho de 320px com a wallet, o saldo em numerais de display e a guilhoche só atrás dele, mais a lista de provas e evidências com marcas.
- Palco com a garantia como título, o botão de executar à direita e, abaixo, o carimbo e a frase do veredito, a faixa de saldo antes→depois e os bilhetes.

FORM: Bilhete Validado, candidato 4 da lista ordenada; seed 1737a155. Gesto assinatura: o carimbo é pressionado quando o veredito chega e o picote separa recibo de estado atual.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
