import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthExpiredError } from '../errors.js';
import { refreshGoogleToken } from '../google.js';
import { refreshMicrosoftToken } from '../microsoft.js';

const okJson = (body) => ({
  ok: true,
  json: async () => body,
});

const errJson = (status, body) => ({
  ok: false,
  status,
  json: async () => body,
});

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('refreshGoogleToken', () => {
  it('throws AuthExpiredError when Google returns invalid_grant', async () => {
    globalThis.fetch = vi.fn(async () => errJson(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    }));

    await expect(refreshGoogleToken('rt')).rejects.toBeInstanceOf(AuthExpiredError);

    try {
      await refreshGoogleToken('rt');
    } catch (err) {
      expect(err.provider).toBe('google');
      expect(err.message).toMatch(/expired or revoked/i);
    }
  });

  it('throws plain Error for transient/non-auth failures', async () => {
    globalThis.fetch = vi.fn(async () => errJson(500, { error: 'internal_error' }));

    await expect(refreshGoogleToken('rt')).rejects.not.toBeInstanceOf(AuthExpiredError);
  });

  it('returns the parsed token JSON on success', async () => {
    globalThis.fetch = vi.fn(async () => okJson({ access_token: 'a', expires_in: 3600 }));
    const tokens = await refreshGoogleToken('rt');
    expect(tokens.access_token).toBe('a');
  });
});

describe('refreshMicrosoftToken', () => {
  it('throws AuthExpiredError when Microsoft returns invalid_grant', async () => {
    globalThis.fetch = vi.fn(async () => errJson(400, {
      error: 'invalid_grant',
      error_description: 'AADSTS70008: refresh token expired',
    }));

    await expect(refreshMicrosoftToken('rt')).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('also treats interaction_required as auth-expired', async () => {
    globalThis.fetch = vi.fn(async () => errJson(400, {
      error: 'interaction_required',
      error_description: 'AADSTS50076: MFA required',
    }));

    const promise = refreshMicrosoftToken('rt');
    await expect(promise).rejects.toBeInstanceOf(AuthExpiredError);
    await expect(promise.catch((e) => e.provider)).resolves.toBe('microsoft');
  });

  it('throws plain Error for transient/non-auth failures', async () => {
    globalThis.fetch = vi.fn(async () => errJson(500, { error: 'internal_error' }));
    await expect(refreshMicrosoftToken('rt')).rejects.not.toBeInstanceOf(AuthExpiredError);
  });
});
