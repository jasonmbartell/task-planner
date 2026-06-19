import { generatePKCE, generateState } from './pkce.js';
import { saveTokens, getTokens } from './tokenStore.js';
import { isTauri } from '../utils/platform.js';
import { getPkceStorage, removePkceStorage } from './google.js';
import { AuthExpiredError } from './errors.js';

const CLIENT_ID = import.meta.env.VITE_MICROSOFT_CLIENT_ID;
const SCOPE = 'Files.ReadWrite.AppFolder offline_access';
const AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

function getRedirectUri() {
  // See google.js — Tauri uses the deep-link scheme, not the dev server URL.
  // Same scheme for both providers so the deep-link handler in useSync.js
  // doesn't have to disambiguate by URL.
  if (isTauri()) {
    return 'com.taskplanner.app:/auth/callback';
  }
  return window.location.origin + '/auth/callback';
}

function setPkceStorage(key, value) {
  if (isTauri()) {
    localStorage.setItem(key, value);
  } else {
    sessionStorage.setItem(key, value);
  }
}

export async function startMicrosoftAuth() {
  const { verifier, challenge } = await generatePKCE();
  const state = generateState();

  setPkceStorage('pkce_verifier', verifier);
  setPkceStorage('oauth_state', state);
  setPkceStorage('oauth_provider', 'microsoft');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    response_mode: 'query',
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const url = `${AUTH_ENDPOINT}?${params}`;

  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } else {
    window.location.href = url;
  }
}

export async function handleMicrosoftCallback(code, returnedState) {
  const savedState = getPkceStorage('oauth_state');
  if (returnedState !== savedState) {
    throw new Error('OAuth state mismatch — possible CSRF attack');
  }

  const verifier = getPkceStorage('pkce_verifier');

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(),
      scope: SCOPE,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error_description || 'Token exchange failed');
  }

  const tokens = await res.json();
  await saveTokens('microsoft', tokens);

  removePkceStorage('pkce_verifier');
  removePkceStorage('oauth_state');
  removePkceStorage('oauth_provider');

  return tokens;
}

export async function refreshMicrosoftToken(refreshToken) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPE,
    }),
  });

  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch { /* non-JSON body */ }
    const description = err.error_description || `Token refresh failed (HTTP ${res.status})`;
    // Microsoft uses the same OAuth2 error codes as Google. invalid_grant
    // (or interaction_required, which Microsoft sometimes returns instead)
    // means the refresh token is unusable and the user must re-auth.
    if (err.error === 'invalid_grant' || err.error === 'interaction_required') {
      throw new AuthExpiredError('microsoft', description);
    }
    throw new Error(description);
  }

  return res.json();
}
