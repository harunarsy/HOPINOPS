import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'hopin-ops-idb';
const STORE_NAME = 'mutation-queue';

export type QueueItem = {
  id: string;
  action: string;
  payload: any;
  createdAt: number;
  status: 'PENDING' | 'SENDING' | 'FAILED';
};

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    },
  });
}

export const idbQueue = {
  async add(action: string, payload: any): Promise<string> {
    const db = await getDb();
    const id = crypto.randomUUID();
    const item: QueueItem = {
      id,
      action,
      payload,
      createdAt: Date.now(),
      status: 'PENDING',
    };
    await db.put(STORE_NAME, item);
    return id;
  },

  async getAll(): Promise<QueueItem[]> {
    const db = await getDb();
    return db.getAll(STORE_NAME);
  },

  async remove(id: string): Promise<void> {
    const db = await getDb();
    await db.delete(STORE_NAME, id);
  },

  async clear(): Promise<void> {
    const db = await getDb();
    await db.clear(STORE_NAME);
  },
};
