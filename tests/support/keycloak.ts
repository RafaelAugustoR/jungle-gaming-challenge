import { createHash } from 'node:crypto';
import { loadConfig } from '../../src/config/config';

// Exercise Authorization Code + PKCE against real Keycloak; password grants stay disabled.
export async function humanToken(username: string): Promise<string> {
  const issuer = loadConfig().keycloakIssuer;
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = 'http://localhost:3000/';
  const query = new URLSearchParams({
    client_id: 'jungle-console',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: crypto.randomUUID(),
  });
  const login = await fetch(`${issuer}/protocol/openid-connect/auth?${query}`, {
    redirect: 'manual',
  });
  const cookies = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
  const html = await login.text();
  const action = html.match(/action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  if (!action) throw new Error(`Keycloak login form missing (${login.status})`);
  const submit = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookies, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password: 'demo-only', credentialId: '' }),
  });
  const location = submit.headers.get('location');
  if (!location) throw new Error(`Keycloak login failed (${submit.status})`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('Keycloak did not return authorization code');
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'jungle-console',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!response.ok || !body.access_token)
    throw new Error(`Keycloak token exchange failed (${response.status})`);
  return body.access_token;
}
export async function providerToken(provider: 'a' | 'b'): Promise<string> {
  const response = await fetch(`${loadConfig().keycloakIssuer}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: `provider-${provider}`,
      client_secret: `provider-${provider}-demo-only`,
    }),
  });
  const body = (await response.json()) as { access_token: string };
  if (!response.ok) throw new Error('Provider credentials failed');
  return body.access_token;
}
