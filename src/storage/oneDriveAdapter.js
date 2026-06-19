import { StorageAdapter } from './adapter.js';
import { getTokens, saveTokens } from '../auth/tokenStore.js';
import { refreshMicrosoftToken } from '../auth/microsoft.js';
import { AuthExpiredError } from '../auth/errors.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me/drive/special/approot';

export class OneDriveAdapter extends StorageAdapter {
  async getAccessToken() {
    const tokens = await getTokens('microsoft');
    if (!tokens) throw new Error('Not authenticated with Microsoft');

    if (tokens.expiresAt - Date.now() < 60_000) {
      let refreshed;
      try {
        refreshed = await refreshMicrosoftToken(tokens.refresh_token);
      } catch (err) {
        // See driveAdapter.getAccessToken for rationale — preserve typed
        // auth-expiry errors so the UI can drop the cloud session.
        if (err instanceof AuthExpiredError) throw err;
        throw new Error(`Microsoft token refresh failed (network error): ${err.message}`);
      }
      await saveTokens('microsoft', { ...tokens, ...refreshed });
      return refreshed.access_token;
    }

    return tokens.access_token;
  }

  async save(filename, data) {
    const token = await this.getAccessToken();
    const res = await fetch(`${GRAPH_BASE}:/${filename}:/content`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OneDrive save failed: ${res.status} ${text}`);
    }

    return res.json();
  }

  async load(filename) {
    try {
      const token = await this.getAccessToken();
      const res = await fetch(`${GRAPH_BASE}:/${filename}:/content`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) return null;
      return res.json();
    } catch (err) {
      if (err instanceof AuthExpiredError) throw err;
      console.error(`[OneDriveAdapter] load failed for ${filename}:`, err);
      return null;
    }
  }

  async list() {
    try {
      const token = await this.getAccessToken();
      const res = await fetch(`${GRAPH_BASE}/children?$select=name`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) return [];
      const json = await res.json();
      return json.value.map(f => f.name);
    } catch (err) {
      if (err instanceof AuthExpiredError) throw err;
      console.error('[OneDriveAdapter] list failed:', err);
      return [];
    }
  }

  async delete(filename) {
    const token = await this.getAccessToken();
    const res = await fetch(`${GRAPH_BASE}:/${filename}:`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`OneDrive delete failed: ${res.status} ${text}`);
    }
  }
}
