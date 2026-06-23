import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri fs + path plugins so writeAgentFile can run under the node
// test runner. Each fn is a spy we can assert call order against.
const fs = {
  readDir: vi.fn(async () => []),
  readTextFile: vi.fn(async () => ''),
  writeTextFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  stat: vi.fn(async () => ({})),
  exists: vi.fn(async () => false),
  rename: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
};

vi.mock('@tauri-apps/plugin-fs', () => fs);
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app',
  // Mirror Tauri's join closely enough for path assertions.
  join: async (...parts) => parts.join('/'),
}));

const { writeAgentFile } = await import('../obsidianTauri.js');

const ROOT = '/data';

describe('writeAgentFile atomic replace (NUL-tail / stale-tail regression)', () => {
  beforeEach(() => {
    for (const spy of Object.values(fs)) spy.mockClear();
    fs.exists.mockResolvedValue(false);
    fs.rename.mockResolvedValue(undefined);
  });

  it('writes the full body to <dest>.tmp then rename()s it over dest', async () => {
    const body = '{"hello":"world"}';
    const dest = await writeAgentFile('snapshot.json', body, ROOT);

    expect(dest).toBe(`${ROOT}/snapshot.json`);

    // Body is written to the temp file in full...
    expect(fs.writeTextFile).toHaveBeenCalledWith(`${ROOT}/snapshot.json.tmp`, body);
    // ...and the temp is renamed over the destination.
    expect(fs.rename).toHaveBeenCalledWith(`${ROOT}/snapshot.json.tmp`, `${ROOT}/snapshot.json`);
  });

  it('NEVER removes the destination before renaming (no missing-file window)', async () => {
    fs.exists.mockResolvedValue(true); // pretend snapshot.json already exists
    await writeAgentFile('snapshot.json', '{"a":1}', ROOT);

    // The whole point of the fix: rename atomically replaces dest, so we must
    // not remove(dest) first. If this fails, someone reintroduced the
    // non-atomic remove-then-rename that left stale tails behind.
    expect(fs.remove).not.toHaveBeenCalledWith(`${ROOT}/snapshot.json`);
    expect(fs.rename).toHaveBeenCalledTimes(1);
  });

  it('falls back to a direct (still truncating) write when rename fails', async () => {
    fs.rename.mockRejectedValueOnce(new Error('EBUSY: dest held open'));
    const body = '{"b":2}';
    await writeAgentFile('snapshot.json', body, ROOT);

    // Direct write to dest, then clean up the orphaned temp.
    expect(fs.writeTextFile).toHaveBeenCalledWith(`${ROOT}/snapshot.json`, body);
    expect(fs.remove).toHaveBeenCalledWith(`${ROOT}/snapshot.json.tmp`);
  });
});
