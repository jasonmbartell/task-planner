import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthExpiredError } from '../../auth/errors.js';

// SyncManager touches window/document/navigator/setTimeout — stub them for
// node. We deliberately avoid jsdom: nothing here needs a full DOM, just a
// few addEventListener stubs and an `online` flag.
let originalWindow;
let originalDocument;
let originalNavigator;

beforeEach(() => {
  originalWindow = globalThis.window;
  originalDocument = globalThis.document;
  originalNavigator = globalThis.navigator;
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.navigator = { onLine: true };
});

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.navigator = originalNavigator;
});

const makeLocal = () => ({
  load: vi.fn(async () => ({ id: 'x', updatedAt: 1 })),
  save: vi.fn(async () => {}),
});

const makeCloudThatFailsAuth = () => ({
  load: vi.fn(async () => { throw new AuthExpiredError('google', 'Token has been expired or revoked.'); }),
  save: vi.fn(async () => { throw new AuthExpiredError('google', 'Token has been expired or revoked.'); }),
  list: vi.fn(async () => { throw new AuthExpiredError('google', 'Token has been expired or revoked.'); }),
});

describe('SyncManager AuthExpiredError handling', () => {
  it('_upload short-circuits without retries on AuthExpiredError and fires onAuthError', async () => {
    const { SyncManager } = await import('../syncManager.js');
    const local = makeLocal();
    const cloud = makeCloudThatFailsAuth();
    const sm = new SyncManager(local, cloud);

    const statuses = [];
    sm.onStatusChange = (s) => statuses.push(s);
    const authErrors = [];
    sm.onAuthError = (err) => authErrors.push(err);

    await sm.save('project-foo.json', { id: 'foo', updatedAt: 5 });

    // The save() call schedules a debounced upload; force-flush to invoke it.
    await sm.flushAll();

    // Cloud save was called exactly once (no 3x retry on auth errors)
    expect(cloud.save).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('error');
    expect(authErrors).toHaveLength(1);
    expect(authErrors[0]).toBeInstanceOf(AuthExpiredError);
    expect(authErrors[0].provider).toBe('google');
    expect(sm.authBroken).toBe(true);
  });

  it('pullAndMerge surfaces auth error via onAuthError, returns local fallback', async () => {
    const { SyncManager } = await import('../syncManager.js');
    const local = makeLocal();
    const cloud = makeCloudThatFailsAuth();
    const sm = new SyncManager(local, cloud);

    const authErrors = [];
    sm.onAuthError = (err) => authErrors.push(err);

    const merged = await sm.pullAndMerge('project-foo.json');

    // Local fallback returned so hydration doesn't blow up
    expect(merged).toEqual({ id: 'x', updatedAt: 1 });
    // Auth callback fired with the right provider
    expect(authErrors).toHaveLength(1);
    expect(authErrors[0].provider).toBe('google');
    expect(sm.authBroken).toBe(true);
    expect(sm.status).toBe('error');
  });

  it('subsequent uploads short-circuit once authBroken — no further cloud calls', async () => {
    const { SyncManager } = await import('../syncManager.js');
    const local = makeLocal();
    const cloud = makeCloudThatFailsAuth();
    const sm = new SyncManager(local, cloud);

    // First call trips authBroken
    await sm.pullAndMerge('a.json');
    expect(sm.authBroken).toBe(true);
    expect(cloud.load).toHaveBeenCalledTimes(1);

    // Now schedule and flush an upload — _upload must skip the cloud entirely
    await sm.save('b.json', { id: 'b', updatedAt: 9 });
    await sm.flushAll();
    expect(cloud.save).toHaveBeenCalledTimes(0);
  });

  it('onAuthError fires only once even across multiple failures', async () => {
    const { SyncManager } = await import('../syncManager.js');
    const sm = new SyncManager(makeLocal(), makeCloudThatFailsAuth());
    const authErrors = [];
    sm.onAuthError = (err) => authErrors.push(err);

    await sm.pullAndMerge('a.json');
    await sm.pullAndMerge('b.json');
    await sm.pullAndMerge('c.json');

    expect(authErrors).toHaveLength(1);
  });

  it('handleAuthError is callable from outside the class (refresh() goes around pullAndMerge)', async () => {
    const { SyncManager } = await import('../syncManager.js');
    const sm = new SyncManager(makeLocal(), makeCloudThatFailsAuth());
    const authErrors = [];
    sm.onAuthError = (err) => authErrors.push(err);

    // Simulate useSync.refresh catching AuthExpiredError from cloudAdapter.list
    const err = new AuthExpiredError('google', 'Token has been expired or revoked.');
    sm.handleAuthError(err);

    expect(sm.authBroken).toBe(true);
    expect(sm.status).toBe('error');
    expect(authErrors).toHaveLength(1);
    expect(authErrors[0]).toBe(err);
  });
});
