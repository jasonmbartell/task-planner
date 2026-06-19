import { generatePKCE, generateState } from './pkce.js';
import { saveTokens } from './tokenStore.js';
import { isTauri } from '../utils/platform.js';
import { AuthExpiredError } from './errors.js';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const CLIENT_SECRET = import.meta.env.VITE_GOOGLE_CLIENT_SECRET;
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

function getRedirectUri() {
  // In Tauri (dev or production), use the reversed-bundle-id custom scheme.
  // Google's iOS OAuth client requires the redirect URI's scheme to match the
  // registered bundle ID exactly (com.taskplanner.app — see tauri.conf.json
  // identifier and the deep-link plugin's schemes list). Microsoft accepts
  // arbitrary schemes, so we reuse the same one for both providers.
  if (isTauri()) {
    return 'com.taskplanner.app:/auth/callback';
  }
  return window.location.origin + '/auth/callback';
}

// In Tauri mode, use localStorage for PKCE state because the deep-link callback
// returns to the Tauri webview (which shares localStorage but not the system
// browser's sessionStorage).
function setPkceStorage(key, value) {
  if (isTauri()) {
    localStorage.setItem(key, value);
  } else {
    sessionStorage.setItem(key, value);
  }
}

export function getPkceStorage(key) {
  if (isTauri()) {
    return localStorage.getItem(key);
  }
  return sessionStorage.getItem(key);
}

export function removePkceStorage(key) {
  if (isTauri()) {
    localStorage.removeItem(key);
  } else {
    sessionStorage.removeItem(key);
  }
}

export async function startGoogleAuth() {
  const { verifier, challenge } = await generatePKCE();
  const state = generateState();

  setPkceStorage('pkce_verifier', verifier);
  setPkceStorage('oauth_state', state);
  setPkceStorage('oauth_provider', 'google');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  // In Tauri, hand the OAuth URL to the system browser. The user signs in there,
  // and the provider redirects to com.taskplanner.app:/auth/callback, which
  // the OS routes back to this app via tauri-plugin-deep-link (handler in
  // useSync.js). In a regular browser, just navigate the current tab as before.
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } else {
    window.location.href = url;
  }
}

export async function handleGoogleCallback(code, returnedState) {
  const savedState = getPkceStorage('oauth_state');
  if (returnedState !== savedState) {
    throw new Error('OAuth state mismatch — possible CSRF attack');
  }

  const verifier = getPkceStorage('pkce_verifier');

  // iOS / installed-app OAuth clients are public clients — no secret. PKCE
  // (code_verifier above) authenticates the request instead. Web clients still
  // require the secret. Send it only when one is configured.
  const body = {
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: getRedirectUri(),
  };
  if (CLIENT_SECRET) body.client_secret = CLIENT_SECRET;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error_description || 'Token exchange failed');
  }

  const tokens = await res.json();
  await saveTokens('google', tokens);

  removePkceStorage('pkce_verifier');
  removePkceStorage('oauth_state');
  removePkceStorage('oauth_provider');

  return tokens;
}

export async function refreshGoogleToken(refreshToken) {
  const body = {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  };
  if (CLIENT_SECRET) body.client_secret = CLIENT_SECRET;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { /* non-JSON body */ }
    const description = err.error_description || `Token refresh failed (HTTP ${res.status})`;
    // invalid_grant means Google has revoked or expired the refresh token —
    // retrying won't help; the UI must drop the cloud session and prompt
    // re-auth. Surface as a typed error so SyncManager / useSync can react.
    if (err.error === 'invalid_grant') {
      throw new AuthExpiredError('google', description);
    }
    throw new Error(description);
  }

  return res.json();
}
