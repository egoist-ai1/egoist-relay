import {
  clear,
  createStore,
  del,
  delMany,
  entries as getEntries,
  get,
  getMany,
  keys as getKeys,
  set,
  setMany,
  update,
  values as getValues,
} from 'idb-keyval';

export class IdbStore {
  public store: ReturnType<typeof createStore>;
  private dbName: string;
  private database?: IDBDatabase;
  private shouldFallbackOnReadError?: boolean;

  constructor(name: string, shouldFallbackOnReadError?: boolean) {
    this.dbName = name;
    this.store = createStore(name, 'store');
    this.shouldFallbackOnReadError = shouldFallbackOnReadError;
  }

  public set(key: string, value: any): Promise<void> {
    return this.runOperation((store) => set(key, value, store));
  }

  public setMany(entries: [string, any][]): Promise<void> {
    return this.runOperation((store) => setMany(entries, store));
  }

  public get<T = unknown>(key: string): Promise<T | undefined> {
    return this.read<T | undefined>((store) => get<T>(key, store), undefined);
  }

  public getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    return this.read<(T | undefined)[]>((store) => getMany<T>(keys, store), keys.map(() => undefined));
  }

  public clear(): Promise<void> {
    return this.runOperation((store) => clear(store));
  }

  public del(key: string): Promise<void> {
    return this.runOperation((store) => del(key, store));
  }

  public delMany(keys: string[]): Promise<void> {
    return this.runOperation((store) => delMany(keys, store));
  }

  public entries(): Promise<[string, any][]> {
    return this.read((store) => getEntries<string>(store), []);
  }

  public keys(): Promise<string[]> {
    return this.read((store) => getKeys<string>(store), []);
  }

  public values<T = unknown>(): Promise<T[]> {
    return this.read((store) => getValues<T>(store), []);
  }

  public update<T = unknown>(key: string, updater: (oldValue: T | undefined) => T): Promise<void> {
    return this.runOperation((store) => update(key, updater, store));
  }

  private async read<T>(operation: (store: typeof this.store) => Promise<T>, fallback: T): Promise<T> {
    try {
      return await this.runOperation(operation);
    } catch (err) {
      if (!this.shouldFallbackOnReadError) throw err;

      // eslint-disable-next-line no-console
      console.warn(`[IDB] Failed to read ${this.dbName}:`, err);
      return fallback;
    }
  }

  private async runOperation<T>(operation: (store: typeof this.store) => Promise<T>, hasRetried?: boolean): Promise<T> {
    const store = this.store;
    let hasStartedTransaction = false;
    const guardedStore: typeof store = (mode, callback) => store(mode, (objectStore) => {
      hasStartedTransaction = true;
      const { transaction } = objectStore;
      const { db: database } = transaction;
      this.database = database;
      database.onversionchange = () => database.close();

      try {
        return Promise.resolve(callback(objectStore)).catch((err) => {
          abortTransaction(transaction);
          throw err;
        });
      } catch (err) {
        abortTransaction(transaction);
        throw err;
      }
    });

    try {
      return await operation(guardedStore);
    } catch (err) {
      if (hasRetried || hasStartedTransaction || !isStaleConnectionError(err)) throw err;

      // Only transactions that have not started can be replayed safely
      if (this.store === store) {
        this.database?.close();
        this.database = undefined;
        this.store = createStore(this.dbName, 'store');
      }

      return this.runOperation(operation, true);
    }
  }
}

function abortTransaction(transaction: IDBTransaction) {
  try {
    transaction.abort();
  } catch {
    // Completed or aborted transactions cannot be aborted again
  }
}

function isStaleConnectionError(err: unknown) {
  return Boolean(err && typeof err === 'object' && 'name' in err
    && (err.name === 'InvalidStateError' || err.name === 'NotFoundError'));
}

export const MAIN_IDB_STORE = new IdbStore('tt-data', true);
export const PASSCODE_IDB_STORE = new IdbStore('tt-passcode');
