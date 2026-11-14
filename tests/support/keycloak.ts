import { createHash } from 'node:crypto';
import { loadConfig } from '../../src/config/config';

export interface PkceLogin {
  issuer: string;
  clientId: string;
  redirectUri: string;
  username: string;
  password: string;
}

// Exercise Authorization Code + PKCE against real Keycloak; password grants stay disabled.
// Shared by integration tests, the stack smoke and the demo recorder so the login form is parsed once.
export async function loginWithPkce({
  issuer,
  clientId,
  redirectUri,
  username,
  password,
}: PkceLogin): Promise<string> {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    client_id: clientId,
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
    body: new URLSearchParams({ username, password, credentialId: '' }),
  });
  const location = submit.headers.get('location');
  if (!location) throw new Error(`Keycloak login failed for ${username} (${submit.status})`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('Keycloak did not return authorization code');
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
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

// Logs in to a running console using the issuer it advertises at /console-config.
export async function consoleLogin(base: string, username: string, password: string) {
  const response = await fetch(`${base}/console-config`);
  if (!response.ok) throw new Error(`Console config unavailable (${response.status})`);
  const config = (await response.json()) as { url: string; realm: string; clientId: string };
  return loginWithPkce({
    issuer: `${config.url}/realms/${config.realm}`,
    clientId: config.clientId,
    redirectUri: `${base}/`,
    username,
    password,
  });
}

export function humanToken(username: string): Promise<string> {
  return loginWithPkce({
    issuer: loadConfig().keycloakIssuer,
    clientId: 'jungle-console',
    redirectUri: 'http://localhost:3000/',
    username,
    password: 'demo-only',
  });
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

export async function allowConsoleRedirect(baseUrl: string) {
  const issuer = new URL(loadConfig().keycloakIssuer);
  const tokenResponse = await fetch(
    `${issuer.origin}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'admin',
        password: 'local-demo-only',
      }),
    },
  );
  const { access_token: token } = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenResponse.ok || !token)
    throw new Error('Could not authorize temporary browser callback.');
  const realm = issuer.pathname.split('/').at(-1);
  const admin = `${issuer.origin}/admin/realms/${realm}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const clientResponse = await fetch(`${admin}/clients?clientId=jungle-console`, { headers });
  const [client] = (await clientResponse.json()) as Array<{
    id: string;
    redirectUris: string[];
    webOrigins: string[];
    [key: string]: unknown;
  }>;
  if (!clientResponse.ok || !client) throw new Error('Could not load the console client.');
  const update = async (redirectUris: string[], webOrigins: string[]) => {
    const response = await fetch(`${admin}/clients/${client.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...client, redirectUris, webOrigins }),
    });
    if (!response.ok) throw new Error('Could not configure the temporary browser callback.');
  };
  const previousRedirects = client.redirectUris;
  const previousOrigins = client.webOrigins;
  // The console keeps deep links (?wallet=…) across login, so allow paths under the base too.
  await update([...previousRedirects, baseUrl, `${baseUrl}/*`], [...previousOrigins, baseUrl]);
  return async () => update(previousRedirects, previousOrigins);
}

/**
 * Keeps an access token fresh in the background. A failed refresh keeps the previous token and
 * is reported, so a later 401 can be traced to the harness instead of looking like a system error.
 */
export async function tokenSource(
  fetchToken: () => Promise<string>,
  options: { refreshMs: number; onError: (error: unknown) => void },
) {
  let token = await fetchToken();
  const timer = setInterval(() => {
    fetchToken().then((next) => (token = next), options.onError);
  }, options.refreshMs);
  return { current: () => token, close: () => clearInterval(timer) };
}
export type TokenSource = Awaited<ReturnType<typeof tokenSource>>;
