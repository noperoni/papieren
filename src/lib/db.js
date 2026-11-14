// IndexedDB wrapper (database design, lib/db.js): the calls the worker and
// the popup need, and nothing more. indexedDB is touched only inside the
// functions, so the file loads under node, and nothing opens until a caller
// asks. Shared-lib pattern, see rules.js.
(() => {
  const NAME = 'papieren';
  const VERSION = 1;

  // Version 1 (design, Data Models). memory's indexes: `key` is [kind, key],
  // `author` is [kind, author, t]. meta keeps out-of-line keys: lastSweep.
  function upgrade(idb) {
    const memory = idb.createObjectStore('memory', { keyPath: ['kind', 'key', 'author'] });
    memory.createIndex('t', 't');
    memory.createIndex('key', ['kind', 'key']);
    memory.createIndex('author', ['kind', 'author', 't']);
    const history = idb.createObjectStore('history', { keyPath: ['day', 'tweet'] });
    history.createIndex('t', 't');
    history.createIndex('tweet', 'tweet');
    idb.createObjectStore('stats', { keyPath: ['day', 'rule'] }).createIndex('day', 'day');
    idb.createObjectStore('flags', { keyPath: ['kind', 'key'] });
    idb.createObjectStore('meta');
  }

  const req = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  // The cached connection. A versionchange (another context deleting the
  // database) or a close drops it, so the next call reopens.
  let conn = null;

  function open() {
    if (conn) return conn;
    let settled = false;
    const p = new Promise((resolve, reject) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => upgrade(r.result);
      r.onsuccess = () => {
        const idb = r.result;
        if (settled) return idb.close(); // answered blocked already
        settled = true;
        const forget = () => { if (conn === p) conn = null; };
        idb.onversionchange = () => { idb.close(); forget(); };
        idb.onclose = forget;
        resolve(idb);
      };
      r.onerror = () => { settled = true; reject(r.error); };
      r.onblocked = () => { settled = true; reject(new Error('blocked')); };
    });
    conn = p;
    p.catch(() => { if (conn === p) conn = null; });
    return p;
  }

  // Runs fn(t) in one transaction and resolves with fn's value once the
  // transaction commits; rejects with the abort's error (QuotaExceededError,
  // say). fn may await only requests of t: any other await lets t commit.
  async function tx(stores, mode, fn) {
    const idb = await open();
    return new Promise((resolve, reject) => {
      const t = idb.transaction(stores, mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onabort = () => reject(t.error ?? new Error('aborted'));
      let run;
      try {
        run = Promise.resolve(fn(t));
      } catch (e) {
        run = Promise.reject(e);
      }
      run.then((v) => { out = v; }, (e) => {
        reject(e);
        try { t.abort(); } catch { /* already finished */ }
      });
    });
  }

  // index null reads the store by primary key; range null reads everything.
  const source = (t, store, index) => (index ? t.objectStore(store).index(index) : t.objectStore(store));

  const put = (t, store, value, key) => req(t.objectStore(store).put(value, key));
  const get = (t, store, key) => req(t.objectStore(store).get(key));
  const count = (t, store, index, range) => req(source(t, store, index).count(range ?? undefined));

  // fn(value, cursor) per row in index order; returning false stops early.
  // The cursor allows cursor.delete() and cursor.update().
  const each = (t, store, index, range, fn) => new Promise((resolve, reject) => {
    const r = source(t, store, index).openCursor(range ?? undefined);
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return resolve();
      try {
        if (fn(c.value, c) === false) return resolve();
      } catch (e) {
        return reject(e);
      }
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });

  // Deletes the rows in range: by primary key (a key or a range) when
  // index is null, else through the index.
  function deleteWhere(t, store, index, range) {
    const os = t.objectStore(store);
    if (!index) return req(os.delete(range));
    return new Promise((resolve, reject) => {
      const r = os.index(index).openKeyCursor(range);
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        os.delete(c.primaryKey);
        c.continue();
      };
      r.onerror = () => reject(r.error);
    });
  }

  // Empties one store or several, in one transaction.
  const clear = (stores) => tx([].concat(stores), 'readwrite', (t) => Promise.all([].concat(stores).map((s) => req(t.objectStore(s).clear()))));

  // Closes the cached connection, then deletes the database. Other open
  // connections close on their versionchange.
  async function drop() {
    const p = conn;
    conn = null;
    if (p) (await p.catch(() => null))?.close();
    await new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(NAME);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  const db = { NAME, VERSION, open, tx, put, get, count, each, deleteWhere, clear, drop };

  globalThis.Papieren ??= {};
  globalThis.Papieren.db = db;
  if (typeof module === 'object') module.exports = db;
})();
