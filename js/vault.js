/*
 * ============================================================================
 * KAPTURA · Vault  (IndexedDB data layer · single responsibility)
 * ============================================================================
 * Pure persistence. No DOM, no rendering — the UI layer owns object URLs so it
 * can revoke them and avoid leaks. Quota failures reject with a clear message
 * instead of failing silently.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  const DB_NAME = 'EtherniumChronoVault';
  const DB_VERSION = 1;
  const STORE = 'recordings';
  let db = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = () => reject(new Error('No se pudo abrir la Bóveda local (IndexedDB).'));
    });
  }

  function add(record) {
    return open().then((d) => new Promise((resolve, reject) => {
      let tx;
      try { tx = d.transaction([STORE], 'readwrite'); }
      catch (e) { return reject(e); }
      const item = {
        ...record,
        blob: record && record.remoteUrl ? null : (record ? record.blob : null),
        sizeBytes: Number(record && (record.sizeBytes || (record.blob && record.blob.size))) || 0,
      };
      const req = tx.objectStore(STORE).add(item);
      req.onsuccess = () => resolve(req.result);
      tx.onabort = () => {
        const err = tx.error || {};
        if (err.name === 'QuotaExceededError') {
          reject(new Error('La Bóveda local está llena. Descarga y elimina grabaciones para liberar espacio.'));
        } else {
          reject(new Error('No se pudo guardar en la Bóveda: ' + (err.message || err.name || 'desconocido')));
        }
      };
    }));
  }

  function getAll() {
    return open().then((d) => new Promise((resolve, reject) => {
      const req = d.transaction([STORE], 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new Error('No se pudo leer la Bóveda.'));
    }));
  }

  function remove(id) {
    return open().then((d) => new Promise((resolve, reject) => {
      const tx = d.transaction([STORE], 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('No se pudo eliminar el elemento.'));
    }));
  }

  function update(id, patch) {
    return open().then((d) => new Promise((resolve, reject) => {
      const tx = d.transaction([STORE], 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const cur = getReq.result;
        if (!cur) return reject(new Error('Elemento no encontrado en la Bóveda.'));
        const next = { ...cur, ...(patch || {}), id };
        const putReq = store.put(next);
        putReq.onsuccess = () => resolve(next);
        putReq.onerror = () => reject(new Error('No se pudo actualizar el elemento de la Bóveda.'));
      };
      getReq.onerror = () => reject(new Error('No se pudo leer el elemento de la Bóveda.'));
    }));
  }

  function clear() {
    return open().then((d) => new Promise((resolve, reject) => {
      const tx = d.transaction([STORE], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('No se pudo vaciar la Bóveda.'));
    }));
  }

  /** Best-effort storage estimate for the telemetry bar. */
  function estimate() {
    if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate();
    return Promise.resolve(null);
  }

  function getRecordMediaSrc(item) {
    if (!item) return { src: '', revoke: () => {} };
    if (item.remoteUrl) return { src: item.remoteUrl, revoke: () => {} };
    if (item.blob instanceof Blob) {
      const url = URL.createObjectURL(item.blob);
      return { src: url, revoke: () => URL.revokeObjectURL(url) };
    }
    return { src: '', revoke: () => {} };
  }

  const api = { open, add, getAll, remove, update, clear, estimate, getRecordMediaSrc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaVault = api;
})(typeof self !== 'undefined' ? self : this);
