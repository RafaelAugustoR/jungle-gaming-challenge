---
target: console de transações frontend/
total_score: 19
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/home/rafael/projects/jungle-gaming-challenge/frontend/index.html"
target_fingerprint: "sha256:5fd6aa27caaa5d7f37d16f37e1c193718466ed02bc6ccd8260b70d12df5843d5"
target_path: /home/rafael/projects/jungle-gaming-challenge/frontend/index.html
timestamp: 2026-11-14T18-40-58Z
slug: frontend-index-html
---
# Critique: console de transações (frontend/)
Total 19/40 (Poor). Heuristics: 1=1, 2=2, 3=2, 4=2, 5=2, 6=2, 7=1, 8=2, 9=2, 10=2.
Specificity: generic SaaS card dashboard; product's core concept (original receipt vs current state, ledger correctness) not visualised. Detector clean (1 false positive em-dash-overuse from '—' empty placeholders).
## Priority issues
1. [P0] Scenario feedback lands outside viewport (results ~1666px, detail ~1072px, errors top #notice). Fix: result surface beside run button, scroll+focus, inline errors. layout
2. [P1] Results are raw machine text, not verdicts. Fix: per-scenario headline, status badges, before→after balance, receipt vs current diff highlight. clarify+colorize
3. [P1] IA fights workflow: global unscoped transaction list first; detail far from scenario. Fix: wallet → actions → result → scoped ledger/transactions; clickable IDs; ?wallet= deep link. layout
4. [P2] Inconsistent states/copy: wrong help text (index.html:186), unstyled disabled input, English native validation, success notice overwritten (app.ts:341 vs 429), raw JS errors (app.ts:378). harden+clarify
5. [P2] Layout polish: 0px gap transactions panel (style.css:393, duplicated at 413), empty th, UUID wrapping, money not pt-BR format. polish+typeset
## Personas
Alex: no deep links/shortcuts, paste UUIDs. Sam: tab order through 50 Detalhes, no focus move after scenario/detail. Jordan: player-facing copy, no start-here, scenarios don't explain what they prove.
## Questions
- What one sentence/visual should evaluator remember per scenario?
- Proof console instead of wallet dashboard?
- Why is the global list first?
