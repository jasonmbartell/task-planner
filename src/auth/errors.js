/**
 * Typed errors for the OAuth / cloud-sync stack.
 *
 * Kept as a separate module so auth code (google.js), storage
 * adapters (driveAdapter), the SyncManager, and the React
 * sync hook can all instanceof-check without importing each other.
 */

/**
 * Thrown when an OAuth refresh-token request returns `invalid_grant` —
 * meaning Google has revoked or expired the refresh token and
 * no number of retries will succeed. The UI should drop the cloud session
 * (clear tokens, null `cloudProvider`, set syncStatus='error') so the
 * "Connected" badge stops lying and the user can click Connect again.
 *
 * Why: previously this case was wrapped as a generic "network error" inside
 * driveAdapter.getAccessToken, which defeated the auth-error string check in
 * SyncManager._upload, masked the real cause in the console, and let the
 * "Connected" badge stay green over a dead refresh token.
 */
export class AuthExpiredError extends Error {
  constructor(provider, message) {
    super(message || 'OAuth refresh token has been expired or revoked');
    this.name = 'AuthExpiredError';
    this.provider = provider;
  }
}
