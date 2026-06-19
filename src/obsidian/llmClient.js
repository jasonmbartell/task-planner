/**
 * LLM API Client
 *
 * Configurable HTTP client for LLM field interpretation.
 * Supports Anthropic Messages API and OpenAI-compatible endpoints.
 *
 * In Tauri: direct fetch works (no CORS restrictions).
 * In browser: works with local LLM servers (localhost) or CORS-enabled endpoints.
 */

const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const MAX_RETRIES = 3;

export class LLMClient {
  /**
   * @param {object} config
   * @param {string} config.apiKey - API key
   * @param {string} [config.endpointUrl] - API endpoint URL
   * @param {string} [config.model] - Model identifier
   */
  constructor({ apiKey, endpointUrl, model }) {
    this.apiKey = apiKey;
    this.endpointUrl = endpointUrl || DEFAULT_ENDPOINT;
    this.model = model || DEFAULT_MODEL;
  }

  /**
   * Detect whether the endpoint is Anthropic or OpenAI-compatible.
   */
  _isAnthropic() {
    return this.endpointUrl.includes('anthropic.com');
  }

  /**
   * Send a message to the LLM and return the text response.
   *
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {object} [options]
   * @param {number} [options.maxTokens=1024] - Response budget. Default is
   *   fine for short field-interpretation replies; prose extraction passes
   *   a much larger value because a full task list can easily exceed 1024
   *   tokens and truncation leaves malformed JSON.
   * @returns {Promise<string>} Response text
   */
  async chat(systemPrompt, userPrompt, options = {}) {
    const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : 1024;
    let lastError;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (this._isAnthropic()) {
          return await this._callAnthropic(systemPrompt, userPrompt, maxTokens);
        } else {
          return await this._callOpenAICompat(systemPrompt, userPrompt, maxTokens);
        }
      } catch (err) {
        lastError = err;

        // Don't retry auth errors
        if (err.status === 401 || err.status === 403) throw err;

        // Rate limit: exponential backoff
        if (err.status === 429) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Other errors: retry with short backoff
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    throw lastError;
  }

  async _callAnthropic(systemPrompt, userPrompt, maxTokens = 1024) {
    const res = await fetch(this.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Anthropic API error ${res.status}: ${body}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  async _callOpenAICompat(systemPrompt, userPrompt, maxTokens = 1024) {
    const res = await fetch(this.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const err = new Error(`LLM API error: ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Quick connection test — sends a minimal request.
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    const response = await this.chat(
      'Respond with exactly: {"ok": true}',
      'Test connection.'
    );
    return response.includes('"ok"') || response.includes('ok');
  }
}
