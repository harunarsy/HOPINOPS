import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'hopin-ops-idb-v2';
const DB_VERSION = 2;
const STORE_NAME = 'mutation-queue';
const BY_SCOPE_AGGREGATE = 'by_scope_aggregate';
const BY_SCOPE_AGGREGATE_CREATED = 'by_scope_aggregate_created';
const BY_SCOPE_AGGREGATE_STATE_NEXT = 'by_scope_aggregate_state_next';
const SENDING_LEASE_MS = 300_000;

export type QueueState = 'PENDING' | 'SENDING' | 'CONFLICT' | 'SYNCED' | 'FAILED';

export type QueueScope = {
  profileId: string;
  outletId: string;
  aggregateId: string;
};

export type QueueItem = QueueScope & {
  id: string;
  idempotencyKey: string;
  baseVersion: number;
  action: string;
  payload: unknown;
  createdAtClient: number;
  attemptCount: number;
  lastErrorCode: string | null;
  nextAttemptAt: number | null;
  state: QueueState;
};

type QueueItemInput = QueueScope & {
  idempotencyKey: string;
  baseVersion: number;
  action: string;
  payload: unknown;
};

function scopeKey(scope: QueueScope): [string, string, string] {
  return [scope.profileId, scope.outletId, scope.aggregateId];
}

function createdRange(scope: QueueScope): IDBKeyRange {
  const prefix = scopeKey(scope);
  return IDBKeyRange.bound(
    [...prefix, 0, ''],
    [...prefix, Number.MAX_SAFE_INTEGER, '\uffff'],
  );
}

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, transaction) {
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? transaction.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: 'id' });

      if (!store.indexNames.contains(BY_SCOPE_AGGREGATE)) {
        store.createIndex(BY_SCOPE_AGGREGATE, ['profileId', 'outletId', 'aggregateId']);
      }
      if (!store.indexNames.contains(BY_SCOPE_AGGREGATE_CREATED)) {
        store.createIndex(BY_SCOPE_AGGREGATE_CREATED, ['profileId', 'outletId', 'aggregateId', 'createdAtClient', 'id']);
      }
      if (!store.indexNames.contains(BY_SCOPE_AGGREGATE_STATE_NEXT)) {
        store.createIndex(BY_SCOPE_AGGREGATE_STATE_NEXT, ['profileId', 'outletId', 'aggregateId', 'state', 'nextAttemptAt']);
      }
    },
  });
}

async function updateScopedItem(
  scope: QueueScope,
  id: string,
  update: (item: QueueItem) => QueueItem | null,
): Promise<QueueItem | null> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  let cursor = await tx.store.index(BY_SCOPE_AGGREGATE).openCursor(IDBKeyRange.only(scopeKey(scope)));
  let result: QueueItem | null = null;

  while (cursor) {
    const item = cursor.value as QueueItem;
    if (item.id === id) {
      const updated = update(item);
      if (updated) {
        await cursor.update(updated);
        result = updated;
      }
      break;
    }
    cursor = await cursor.continue();
  }

  await tx.done;
  return result;
}

export const idbQueue = {
  async add(item: QueueItemInput): Promise<string> {
    if (
      !item.profileId
      || !item.outletId
      || !item.aggregateId
      || !item.idempotencyKey
      || !Number.isFinite(item.baseVersion)
      || item.baseVersion < 0
    ) {
      const error = new Error('Queue item scope or concurrency metadata is invalid.') as Error & { code: string };
      error.code = 'INVALID_QUEUE_ITEM';
      throw error;
    }

    const db = await getDb();
    const id = crypto.randomUUID();
    const now = Date.now();
    const record: QueueItem = {
      ...item,
      id,
      createdAtClient: now,
      attemptCount: 0,
      lastErrorCode: null,
      nextAttemptAt: now,
      state: 'PENDING',
    };
    await db.put(STORE_NAME, record);
    return id;
  },

  async getForAggregate(scope: QueueScope): Promise<QueueItem[]> {
    const db = await getDb();
    const items = await db.getAllFromIndex(STORE_NAME, BY_SCOPE_AGGREGATE_CREATED, createdRange(scope)) as QueueItem[];
    return items.sort((a, b) => a.createdAtClient - b.createdAtClient || a.id.localeCompare(b.id));
  },

  async recoverSending(scope: QueueScope): Promise<void> {
    const items = await this.getForAggregate(scope);
    for (const item of items) {
      if (item.state !== 'SENDING' || (item.nextAttemptAt !== null && item.nextAttemptAt > Date.now())) continue;
      await updateScopedItem(scope, item.id, (current) => current.state === 'SENDING'
        && (current.nextAttemptAt === null || current.nextAttemptAt <= Date.now())
        ? { ...current, state: 'PENDING', nextAttemptAt: Date.now() }
        : null);
    }
  },

  async markSending(scope: QueueScope, id: string): Promise<QueueItem | null> {
    return updateScopedItem(scope, id, (item) => {
      if (item.state !== 'PENDING' || (item.nextAttemptAt !== null && item.nextAttemptAt > Date.now())) {
        return null;
      }
      return {
        ...item,
        state: 'SENDING',
        attemptCount: item.attemptCount + 1,
        lastErrorCode: null,
        nextAttemptAt: Date.now() + SENDING_LEASE_MS,
      };
    });
  },

  async markPending(scope: QueueScope, id: string, lastErrorCode: string, nextAttemptAt: number): Promise<void> {
    await updateScopedItem(scope, id, (item) => ({
      ...item,
      state: 'PENDING',
      lastErrorCode,
      nextAttemptAt,
    }));
  },

  async markConflict(scope: QueueScope, id: string, lastErrorCode: string): Promise<void> {
    await updateScopedItem(scope, id, (item) => ({
      ...item,
      state: 'CONFLICT',
      lastErrorCode,
      nextAttemptAt: null,
    }));
  },

  async markFailed(scope: QueueScope, id: string, lastErrorCode: string): Promise<void> {
    await updateScopedItem(scope, id, (item) => ({
      ...item,
      state: 'FAILED',
      lastErrorCode,
      nextAttemptAt: null,
    }));
  },

  async remove(scope: QueueScope, id: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    let cursor = await tx.store.index(BY_SCOPE_AGGREGATE).openCursor(IDBKeyRange.only(scopeKey(scope)));
    while (cursor) {
      const item = cursor.value as QueueItem;
      if (item.id === id) {
        await cursor.delete();
        break;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  },
};
