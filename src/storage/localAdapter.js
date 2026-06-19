import { openDB } from 'idb';
import { StorageAdapter } from './adapter.js';

const DB_NAME = 'task-planner-data';
const DB_VERSION = 1;
const STORE_NAME = 'files';

function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    },
  });
}

export class LocalAdapter extends StorageAdapter {
  async save(filename, data) {
    const db = await getDB();
    await db.put(STORE_NAME, { data, savedAt: Date.now() }, filename);
  }

  async load(filename) {
    const db = await getDB();
    const record = await db.get(STORE_NAME, filename);
    return record?.data ?? null;
  }

  async list() {
    const db = await getDB();
    return db.getAllKeys(STORE_NAME);
  }

  async delete(filename) {
    const db = await getDB();
    await db.delete(STORE_NAME, filename);
  }
}
