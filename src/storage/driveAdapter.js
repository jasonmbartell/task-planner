import { StorageAdapter } from './adapter.js';
import { getTokens, saveTokens } from '../auth/tokenStore.js';
import { refreshGoogleToken } from '../auth/google.js';
import { AuthExpiredError } from '../auth/errors.js';

export class DriveAdapter extends StorageAdapter {
  constructor() {
    super();
    this.baseUrl = 'https://www.googleapis.com/drive/v3';
    this.uploadUrl = 'https://www.googleapis.com/upload/drive/v3';
    this._fileIdCache = {};
  }

  async getAccessToken() {
    const tokens = await getTokens('google');
    if (!tokens) throw new Error('Not authenticated with Google');

    // Refresh if within 60 seconds of expiry
    if (tokens.expiresAt - Date.now() < 60_000) {
      let refreshed;
      try {
        refreshed = await refreshGoogleToken(tokens.refresh_token);
      } catch (err) {
        // Don't bury structured auth-expiry errors — those tell the UI to
        // drop the session and prompt re-auth. Only fetch network failures
        // get the "(network error)" wrapper.
        if (err instanceof AuthExpiredError) throw err;
        throw new Error(`Google token refresh failed (network error): ${err.message}`);
      }
      const merged = {
        ...tokens,
        ...refreshed,
        // Keep the existing refresh_token if the response doesn't include one
        refresh_token: refreshed.refresh_token || tokens.refresh_token,
      };
      await saveTokens('google', merged);
      return merged.access_token;
    }

    return tokens.access_token;
  }

  async findFileId(filename) {
    if (this._fileIdCache[filename]) return this._fileIdCache[filename];

    const token = await this.getAccessToken();
    const q = encodeURIComponent(`name='${filename}'`);
    const res = await fetch(
      `${this.baseUrl}/files?spaces=appDataFolder&q=${q}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) throw new Error(`Drive search failed: ${res.status}`);

    const { files } = await res.json();
    if (files && files.length > 0) {
      this._fileIdCache[filename] = files[0].id;
      return files[0].id;
    }
    return null;
  }

  async save(filename, data) {
    const token = await this.getAccessToken();
    const body = JSON.stringify(data);
    const fileId = await this.findFileId(filename);

    if (fileId) {
      // Update existing file with PATCH
      const res = await fetch(
        `${this.uploadUrl}/files/${fileId}?uploadType=media`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Drive update failed: ${res.status} ${text}`);
      }
      return res.json();
    }

    // Create new file via multipart upload
    const boundary = '----TaskPlannerBoundary' + Date.now();
    const metadata = JSON.stringify({
      name: filename,
      parents: ['appDataFolder'],
    });

    const multipartBody =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      metadata + '\r\n' +
      `--${boundary}\r\n` +
      'Content-Type: application/json\r\n\r\n' +
      body + '\r\n' +
      `--${boundary}--`;

    const res = await fetch(
      `${this.uploadUrl}/files?uploadType=multipart`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Drive create failed: ${res.status} ${text}`);
    }

    const created = await res.json();
    this._fileIdCache[filename] = created.id;
    return created;
  }

  async load(filename) {
    try {
      const fileId = await this.findFileId(filename);
      if (!fileId) return null;

      const token = await this.getAccessToken();
      const res = await fetch(
        `${this.baseUrl}/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (res.status === 404) return null;
      if (!res.ok) return null;

      return res.json();
    } catch (err) {
      // AuthExpiredError must surface so SyncManager / useSync can drop
      // the dead cloud session and stop showing a green "Connected" badge.
      if (err instanceof AuthExpiredError) throw err;
      console.error(`[DriveAdapter] load failed for ${filename}:`, err);
      return null;
    }
  }

  async list() {
    try {
      const token = await this.getAccessToken();
      const res = await fetch(
        `${this.baseUrl}/files?spaces=appDataFolder&fields=files(name)&pageSize=100`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!res.ok) return [];

      const { files } = await res.json();
      return (files || []).map((f) => f.name);
    } catch (err) {
      if (err instanceof AuthExpiredError) throw err;
      console.error('[DriveAdapter] list failed:', err);
      return [];
    }
  }

  async delete(filename) {
    const fileId = await this.findFileId(filename);
    if (!fileId) return;

    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.baseUrl}/files/${fileId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok && res.status !== 404) {
      throw new Error(`Drive delete failed: ${res.status}`);
    }

    delete this._fileIdCache[filename];
  }
}
