import { openDB } from 'idb';

const getDB = () => openDB('task-planner-auth', 1, {
  upgrade(db) { db.createObjectStore('tokens'); }
});

export async function saveTokens(provider, tokens) {
  const db = await getDB();
  await db.put('tokens', {
    ...tokens,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }, provider);
}

export async function getTokens(provider) {
  const db = await getDB();
  return db.get('tokens', provider);
}

export async function clearTokens(provider) {
  const db = await getDB();
  return db.delete('tokens', provider);
}
