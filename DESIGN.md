---
name: "Lastro · Console de prova"
description: "Bilhete Validado: cada garantia do processador de apostas sai como um bilhete conferido, impresso em papel de segurança com trilho em tinta violeta."
colors:
  rail: "#24164f"
  rail-deep: "#190e3a"
  rail-2: "#33226e"
  rail-ink: "#f3f0ff"
  rail-muted: "#bdb4e6"
  rail-rule: "rgb(255 255 255 / 0.14)"
  ticket: "#ffd23f"
  ticket-ink: "#2e2200"
  held: "#0b7a45"
  held-bg: "#e0f3e8"
  void: "#b3192f"
  void-bg: "#fce3e7"
  void-on-rail: "#ff7b8c"
  pending: "#8a5300"
  pending-bg: "#fff0c4"
  pending-on-rail: "#ffd23f"
  paper: "#efecf8"
  sheet: "#fcfbff"
  ink: "#16122b"
  ink-2: "#4b4566"
  rule: "#d8d2ea"
  rule-strong: "#a69dc7"
  focus: "#5b3fd9"
typography:
  display:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(40px, 3.6vw, 54px)"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 72"
  headline:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(34px, 4.2vw, 56px)"
    fontWeight: 750
    lineHeight: 1.04
    letterSpacing: "-0.025em"
    fontVariation: "'wdth' 78"
  headline-stage:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(28px, 2.6vw, 38px)"
    fontWeight: 750
    lineHeight: 1.15
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 80"
  title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 92"
  figure:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 70"
    fontFeature: "'tnum'"
  body:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "'tnum'"
  label-stamp:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 850
    lineHeight: 1
    letterSpacing: "0.08em"
    fontVariation: "'wdth' 62"
  label-section:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 750
    letterSpacing: "0.08em"
    fontVariation: "'wdth' 72"
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "0.82em"
    fontWeight: 400
    letterSpacing: "0"
rounded:
  none: "0px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  2xl: "36px"
  3xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.rail-2}"
    textColor: "{colors.rail-ink}"
  button-primary-large:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.none}"
    padding: "0 22px"
    height: "48px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "40px"
  button-secondary-hover:
    backgroundColor: "#e4dff5"
    textColor: "{colors.ink}"
  button-ghost-on-rail:
    backgroundColor: "transparent"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.none}"
    padding: "0 12px"
    height: "34px"
  button-ghost-on-rail-hover:
    backgroundColor: "{colors.rail-2}"
    textColor: "{colors.rail-ink}"
  input:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0 12px"
    height: "42px"
  rail-item:
    backgroundColor: "transparent"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.none}"
    padding: "0 10px"
    height: "40px"
  rail-item-hover:
    backgroundColor: "{colors.rail-2}"
    textColor: "{colors.rail-ink}"
  rail-item-current:
    backgroundColor: "{colors.ticket}"
    textColor: "{colors.ticket-ink}"
  wallet-card:
    backgroundColor: "{colors.rail-deep}"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.none}"
    padding: "16px"
  sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "24px"
  run-bar:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "16px 18px"
  ticket-head:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    padding: "8px 14px 8px 22px"
  ticket-stub:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    padding: "14px 16px 16px 22px"
  ticket-validation-held:
    backgroundColor: "{colors.held-bg}"
    textColor: "{colors.ink}"
    padding: "14px 16px 16px"
  ticket-validation-pending:
    backgroundColor: "{colors.pending-bg}"
    textColor: "{colors.ink}"
    padding: "14px 16px 16px"
  ticket-validation-void:
    backgroundColor: "{colors.void-bg}"
    textColor: "{colors.ink}"
    padding: "14px 16px 16px"
  ticket-kind:
    backgroundColor: "{colors.ticket}"
    textColor: "{colors.ticket-ink}"
    typography: "{typography.label-section}"
    padding: "0 6px"
  stamp-held:
    textColor: "{colors.held}"
    typography: "{typography.label-stamp}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
  stamp-violated:
    textColor: "{colors.void}"
    typography: "{typography.label-stamp}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
  stamp-inconclusive:
    textColor: "{colors.pending}"
    typography: "{typography.label-stamp}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
  balance-strip:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    padding: "12px 18px"
  score:
    backgroundColor: "{colors.ticket}"
    textColor: "{colors.ticket-ink}"
    padding: "1px 7px"
  score-complete:
    backgroundColor: "{colors.held}"
    textColor: "#ffffff"
    padding: "1px 7px"
  kind-tag:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "1px 6px"
  state-mark:
    size: "16px"
    rounded: "{rounded.none}"
  state-mark-sm:
    size: "14px"
    rounded: "{rounded.none}"
---

# Design System: Lastro · Console de prova

## Overview

**Creative North Star: "Bilhete Validado"**

O console é impressão de segurança de bilhete de loteria aplicada a uma ferramenta de prova. Cada garantia financeira sai como um bilhete conferido: o recibo original fica no canhoto, o estado atual fica na via de validação, os dois separados por um picote, e o veredito chega como um carimbo pressionado. A moldura é tinta violeta (topo, trilho, cabeçalhos de bilhete, faixa de saldo); o conteúdo é papel de segurança lavanda e folhas quase brancas. O amarelo de bilhete marca o que está ativo agora. Verde valida, vermelho anula, âmbar espera.

A densidade é de documento conferido, não de painel: fios de 1px, cantos retos, poucas superfícies, numerais grandes e condensados onde há valor. A tipografia é uma família só, Archivo, cujo eixo de largura carrega a hierarquia: largura normal para leitura, condensada para carimbos, saldos, rótulos e tipos de operação. Mono (JetBrains Mono) aparece só em IDs, seriais e códigos de status. A guilhoche, a rosácea de segurança, existe só atrás do saldo da wallet, onde o valor está impresso.

O mundo recusa o dashboard de cards de KPI e a tabela crua de recibos. A evidência é mostrada como objeto (bilhete, carimbo, faixa antes→depois, linha de ledger que fecha), e cada estado é sempre forma + texto, nunca só cor.

**Key Characteristics:**
- Moldura em tinta violeta, conteúdo em papel lavanda; amarelo só para o ativo.
- Cantos retos em tudo; os únicos círculos são os furos do picote.
- Archivo com eixo de largura: quanto mais condensado, mais "impresso" é o elemento.
- Marcas de estado em célula fixa: cheia mantida, tracejada pendente, riscada anulada.
- Um gesto assinatura: o carimbo pressionado uma vez quando o veredito chega.

## Colors

Paleta de impressão de segurança: um violeta-tinta profundo que emoldura, papel lavanda frio, um amarelo de bilhete único e três tintas de estado.

### Primary
- **Tinta Violeta de Segurança** (`rail`): trilho lateral, faixa de saldo antes→depois, cabeçalho de cada bilhete, botão primário e o painel da landing. É a moldura do mundo; também é `accent-color`, `caret-color` e `theme-color`.
- **Violeta Noturno** (`rail-deep`): barra superior e cartão da wallet (sob a guilhoche). Um degrau mais fundo que o trilho, para separar produto de navegação.
- **Violeta de Realce** (`rail-2`): hover sobre o trilho e sobre o botão primário.

### Secondary
- **Amarelo Bilhete** (`ticket`) com **Tinta sobre Amarelo** (`ticket-ink`): a prova atual no trilho, o fio superior de 3px da barra de execução, a etiqueta de tipo de operação no bilhete, a nota "mudou", o placar e o resumo "5 de 5". Também é a cor de seleção de texto e do link "pular para o conteúdo".

### Tertiary (tintas de estado)
- **Verde que Valida** (`held`) / **Via Validada** (`held-bg`): carimbo "garantia mantida", marca cheia, crédito no ledger, linha de fechamento da reconciliação, fundo da via de validação processada, placar completo.
- **Vermelho que Anula** (`void`) / **Via Anulada** (`void-bg`): carimbo de violação, marca riscada, débito no ledger, borda de campo inválido, nota de erro, linha que diverge. Sobre o trilho usa **Vermelho sobre Trilho** (`void-on-rail`).
- **Âmbar de Espera** (`pending`) / **Via Pendente** (`pending-bg`): carimbo inconclusivo, marca tracejada, `PENDING_REFERENCE`. Sobre o trilho usa `pending-on-rail` (o mesmo amarelo de bilhete).

### Neutral
- **Papel de Segurança Lavanda** (`paper`): fundo da página, cabeçalho de tabela, preenchimento dos furos do picote.
- **Folha Bilhete** (`sheet`): corpo do bilhete, folhas de formulário, barra de execução, tabela.
- **Tinta Grafite Violácea** (`ink`) e **Grafite Secundário** (`ink-2`): texto principal e texto de apoio (lede, rótulos de `dt`, metadados).
- **Fio Claro** (`rule`) e **Fio de Picote** (`rule-strong`): fios de 1px entre linhas e bordas de folha; o mais forte desenha o picote, bordas de bilhete e de campo.
- **Branco Lavanda** (`rail-ink`), **Lilás Esmaecido** (`rail-muted`) e **Fio Translúcido** (`rail-rule`): texto, texto de apoio e fios sobre o trilho.
- **Violeta de Foco** (`focus`): anel de foco de 2px no papel e marcador "replay: sim". Sobre o trilho o foco passa a ser amarelo de bilhete.

### Named Rules
**The Ink Frame Rule.** O violeta emoldura, o papel contém. Topo, trilho, cabeçalho de bilhete e faixa de saldo são tinta; tudo o que é lido como evidência fica em `paper` ou `sheet`.

**The One Ticket Rule.** Amarelo marca o único item ativo ou ganho na tela: a prova atual, a barra de execução, o tipo da operação, o que mudou, o placar. Nunca é fundo de seção nem decoração.

**The Three Inks Rule.** Verde mantém, vermelho anula, âmbar espera, e nenhuma das três aparece sem a marca de forma e o texto do estado ao lado.

## Typography

**Display Font:** Archivo variável (pesos 100–900, largura 62–125%), self-hosted, com fallback `system-ui, sans-serif`
**Body Font:** Archivo (o mesmo arquivo)
**Label/Mono Font:** JetBrains Mono 400/500, com fallback `ui-monospace, monospace`

**Character:** Uma grotesca de largura variável faz o papel de toda a gráfica de segurança: aberta para ler, apertada para imprimir valor e carimbar. O mono é a numeração do bilhete, nunca texto corrido. Numerais são tabulares por padrão em todo o documento.

### Hierarchy
- **Display** (650, largura 72%, `clamp(40px, 3.6vw, 54px)`, lh 1): o saldo da wallet no trilho, com a moeda em amarelo a 0,36em. Único lugar com tamanho de display.
- **Headline** (750, largura 78%, `clamp(34px, 4.2vw, 56px)`, lh 1.04): a frase da landing, máx. 17ch.
- **Headline de palco** (750, largura 80%, `clamp(28px, 2.6vw, 38px)`): a garantia como título de cada prova e os títulos de Bilhetes e Ledger.
- **Title** (650, largura 92%, 21px, lh 1.3): a frase do veredito, máx. 48ch, `text-wrap: pretty`.
- **Figure** (700, largura 70%, 30px): valores dentro do bilhete; variantes de 28px na faixa de saldo e 18px no cabeçalho do bilhete.
- **Body** (400, 15px, lh 1.55): texto corrido; lede a 16px com máx. 62ch; nota de execução máx. 52ch.
- **Label-stamp** (850, largura 62%, 19px, caixa alta, 0.08em): só o carimbo.
- **Label-section** (750, largura 72%, 12px, caixa alta, 0.08em): títulos de metade do bilhete ("Canhoto", "Via de validação"), cabeçalho de tabela, títulos de grupo do trilho, etiqueta de tipo.
- **Mono** (400, 0.82em): IDs, external IDs, serial do bilhete, código cru de status.

### Named Rules
**The Width Axis Rule.** A hierarquia se faz pela largura antes do tamanho: títulos a 78–92%, figuras a 70–72%, carimbo a 62%. Texto de leitura fica em 100%.

**The Serial-Only Mono Rule.** Mono é só para o que seria número de série num bilhete: UUIDs, external IDs, códigos `PROCESSED`/`PENDING_REFERENCE`. Rótulos e valores em dinheiro ficam em Archivo.

## Layout

Grade de dois campos sob uma barra fixa de 52px: um **trilho** de 300px à esquerda (sticky, rolagem própria) e um **palco** fluido à direita, com padding `36px clamp(20px, 3.6vw, 56px) 72px` e conteúdo limitado a 1040px. O trilho é pintado também no fundo do console por gradiente, para não terminar antes da página.

O palco segue sempre a mesma ordem: título da garantia e lede → passos (lista tracejada) → barra de execução com o botão à direita → veredito (frase à esquerda, carimbo à direita) → faixa de saldo antes→depois → bilhetes empilhados com 14px de intervalo. O resultado aparece logo abaixo da ação.

A landing é um split `1.25fr / 1fr` (mín. 320px): texto à esquerda sobre papel, e à direita o painel violeta com a lista de provas impressa como bilhete.

Ritmo de espaçamento observado: 4, 8, 12, 16, 20, 24, 36, 48px. Linhas de definição usam coluna fixa de rótulo (112px no bilhete, 52px no cartão da wallet).

**Responsivo:**
- **≤960px:** o trilho vira cabeçalho estático; o cartão da wallet põe o saldo à direita; a navegação de provas vira faixa horizontal rolável, sem títulos de grupo; o carimbo sobe para antes da frase do veredito.
- **≤640px:** o palco usa 16px de gutter; canhoto e via empilham e o picote vira horizontal; a barra de execução ocupa a largura toda; a tabela do ledger vira lista de linhas (versão, tipo e valor na primeira linha, external ID e "Saldo após" abaixo).

## Elevation & Depth

O sistema é plano e conta profundidade por tinta e fio, não por sombra. A camada mais funda é o violeta, o papel lavanda fica no meio e a folha quase branca por cima; bordas de 1px separam as folhas. O fundo tonal da via de validação (verde, âmbar ou vermelho claros) diz o estado sem levantar nada. A guilhoche é a única textura e fica a 7,5% de opacidade.

### Shadow Vocabulary
- **Bilhete erguido da landing** (`box-shadow: 0 18px 40px rgb(10 4 30 / 0.35)`): só no bilhete de apresentação sobre o painel violeta da landing. Não aparece no console.

### Named Rules
**The Printed Flat Rule.** Superfícies do console não têm sombra. Separação vem de fio de 1px ou de troca de tinta; estado vem de fundo tonal.

**The Guilloche Behind Value Rule.** A rosácea de segurança aparece só atrás de onde há valor impresso (o saldo da wallet). Não vira padrão de fundo de página nem de outras superfícies.

## Shapes

Cantos retos em tudo (`rounded.none`): botões, campos, folhas, bilhetes, carimbo, marcas, etiquetas. Fios têm 1px; a exceção é o fio amarelo de 3px no topo da barra de execução e a borda dupla do carimbo (2px fora, 1px dentro). Linhas tracejadas significam "em aberto": passos, estado bloqueado, vazio, marca pendente, ambiente na barra superior.

O bilhete tem dois recortes próprios: uma coluna de furos de 4px de raio, a cada 14px, na borda do canhoto (máscara), e o **picote** entre canhoto e via, uma linha tracejada de 1,5px com dois meios-furos de 16px nas pontas, preenchidos com a cor do papel. Esses são os únicos círculos do sistema.

Ícones: um conjunto próprio em grade de 24px, traço 1.75, pontas quadradas, para combinar com os fios retos.

### Named Rules
**The Square Corner Rule.** Nenhum raio de canto. Se é redondo, é um furo no papel.

## Components

### Buttons
Tinta firme, retangular, sem ornamento.
- **Shape:** cantos retos, borda de 1px, altura mínima 40px, gap de 8px entre ícone e texto, peso 600.
- **Primary:** fundo `rail`, texto `rail-ink`. Variante grande (48px, 16px de texto) para o botão de executar a prova.
- **Secondary (padrão):** transparente com borda `ink`; hover `#e4dff5`, ativo `#d6cff0`.
- **Ghost sobre trilho:** borda `rail-rule`, 34px, hover `rail-2`. Usado em "Sair".
- **Link do trilho:** sem borda, sublinhado com offset 3px; o sublinhado fica amarelo no hover.
- **Hover / Focus:** transição de fundo e cor em 160ms com `--ease-out`; foco é contorno de 2px `focus` com offset 2px (amarelo sobre o trilho). Desabilitado a 50% de opacidade.

### Inputs / Fields
- **Style:** fundo branco, borda 1px `rule-strong`, 42px, cantos retos; rótulo 13px peso 600 acima, gap 6px.
- **Campo de dinheiro:** prefixo "R$" em `ink-2` dentro da mesma borda, numerais tabulares.
- **Focus:** borda passa a `focus` com contorno de 2px.
- **Error:** borda `void`, mensagem 600 em `void`; nota de erro com borda e fundo vermelhos e ícone de alerta.

### Navigation (trilho)
- **Style:** itens de 40px em grade fixa (número · marca · rótulo · cadeado), texto `rail-ink` peso 500, títulos de grupo em label-section `rail-muted` com o placar à direita.
- **States:** hover `rail-2`; atual (`aria-current`) em amarelo bilhete com tinta escura e peso 650; bloqueado a 45%.
- **Conclusão:** bloco amarelo "5 de 5 garantias mantidas" com marca verde, em live region.
- **Mobile:** vira faixa horizontal rolável sob o cartão da wallet.

### Chips / Etiquetas
- **Tipo no bilhete** (`ticket-kind`): amarelo sólido, label-section 800 a 70%.
- **Tipo no ledger** (`kind-tag`): só borda `rule-strong`, 12px 700 a 75%.
- **Placar:** amarelo enquanto incompleto, verde com texto branco quando 5/5.

### Cards / Containers
- **Folha** (`sheet`): fundo `sheet`, borda 1px `rule`, padding 24px, sem sombra.
- **Barra de execução:** folha com fio amarelo de 3px no topo; nota à esquerda, ações à direita.
- **Cartão da wallet:** `rail-deep` com guilhoche de 120px, borda `rail-rule`, saldo em display.

### State Mark (assinatura)
Célula fixa de 16px (14px pequena), borda 1,5px, sem raio. **Cheia** (`held`) = mantida; **tracejada** (`pending`) = pendente, girando 90° em 1,2s enquanto executa; **riscada** com X (`void`) = anulada/violada; esmaecida = não executada. Sempre acompanhada de texto; o código cru de status em mono vem ao lado.

### Ticket (assinatura)
Cabeçalho em tinta violeta (rótulo, etiqueta de tipo amarela, valor em figura condensada, serial em mono à direita). Corpo em três colunas `1fr · 28px · 1.15fr`: **canhoto** com o recibo original imutável, **picote**, **via de validação** com o estado atual em fundo tonal (verde, âmbar, vermelho; transição de 400ms). Quando o estado mudou desde o recibo, a linha ganha a nota amarela "mudou". Furos de destaque na borda esquerda. No celular, canhoto e via empilham com picote horizontal.

### Stamp (assinatura)
Carimbo em caixa alta, Archivo 850 a 62%, borda dupla (2px + 1px interna), girado −4°, fundo tonal a 70%. Três tintas: "garantia mantida" (`held`), violada (`void`), inconclusiva (`pending`). Entra uma única vez com `stamp-press` (520ms, de escala 1,35 e desfoque 1,5px para 1).

### Balance Strip
Faixa violeta com o saldo antes, seta amarela e saldo depois, em figuras condensadas de 28px (18px no celular).

### Ledger
Tabela em folha com cabeçalho label-section sobre `paper`, valores alinhados à direita, débito em `void`, crédito em `held`, saldo corrente em 650; a linha de rodapé fecha em `held-bg` ou diverge em `void-bg`.

## Do's and Don'ts

### Do:
- **Do** emoldurar com `rail`/`rail-deep` e manter a evidência em `paper`/`sheet` (The Ink Frame Rule).
- **Do** usar o amarelo `ticket` só no item ativo, no tipo da operação, no que mudou e no placar (The One Ticket Rule).
- **Do** acompanhar toda cor de estado com a marca de célula fixa e o texto do estado (The Three Inks Rule).
- **Do** mostrar recibo original e estado atual em lados opostos de um picote, nunca na mesma célula.
- **Do** usar o eixo de largura da Archivo para hierarquia: 62% no carimbo, ~70% em valores, 78–92% em títulos, 100% em leitura.
- **Do** manter mono restrito a IDs, seriais e códigos crus de status.
- **Do** colocar o resultado logo abaixo da barra de execução: veredito, carimbo, faixa antes→depois, bilhetes.
- **Do** manter foco de 2px visível (violeta no papel, amarelo no trilho) e desligar animações e transições sob `prefers-reduced-motion`.

### Don't:
- **Don't** usar raio de canto; os únicos círculos são furos de picote e de destaque.
- **Don't** pôr sombra em superfícies do console; a única sombra é a do bilhete de apresentação da landing.
- **Don't** montar cards de KPI ou tabelas cruas de recibos como mensagem principal; o veredito vem antes do dado.
- **Don't** espalhar a guilhoche por fundos; ela fica atrás do saldo.
- **Don't** animar o carimbo mais de uma vez nem usar outro movimento decorativo; só o carimbo, a marca girando enquanto executa e as transições de estado.
- **Don't** usar o nome, logo ou cores da Jungle Gaming nem de casa de aposta real.
