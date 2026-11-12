# Identidade de máquina por provedor

Cada provedor terá um cliente de máquina no Keycloak, autenticado por OAuth2 Client Credentials e vinculado a um providerId configurado. A API rejeitará com 403 uma operação cujo providerId não corresponda à identidade autenticada, sem produzir efeito financeiro. Serão configurados dois provedores de demonstração para testar essa separação.

Mensagens SQS permanecem no canal interno confiável definido pelo README, sem token OAuth por mensagem; o processamento valida a identidade de domínio do provedor e as relações da operação. Essa confiança depende do controle de acesso à fila e não torna um providerId arbitrário confiável fora desse canal.

Essa escolha reutiliza o IdP adotado para o console, mas mantém identidades humanas e de integração separadas. Referências: [README](https://github.com/junglegaming/backend-challenge), seção 2; [Keycloak service accounts](https://www.keycloak.org/docs/26.6.4/server_admin/index.html). Decisão aprovada no grill em 2026-11-11.
