const DB_NAME = 'moshafi_offline_db';
const DB_VERSION = 1;
const AUDIO_CACHE_NAME = 'moshafi-audio-v1';

const DEFAULT_STATE = {
  theme: 'light',
  quranFontSize: 28,
  uiFontSize: 16,
  mushafMode: 'page', // 'page' | 'verse'
  reciterId: 7, // Mishary Rashid Alafasy on Quran.com API v4
  tafsirId: 16, // التفسير الميسر
  playbackRate: 1,
  simpleMode: false,
  lastReading: { surah: 1, ayah: 1, page: 1 },
  lastListening: { surah: 1, ayah: 1, reciterId: 7, time: 0 },
  pageBookmarks: [],
  favoriteVerses: []
};

export class StorageManager {
  constructor() {
    this.db = null;
  }

  async init() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('surah_packages')) {
          db.createObjectStore('surah_packages', { keyPath: 'key' }); // key: `${reciterId}_${surahId}`
        }
        if (!db.objectStoreNames.contains('pages_cache')) {
          db.createObjectStore('pages_cache', { keyPath: 'pageNumber' });
        }
        if (!db.objectStoreNames.contains('tafsir_cache')) {
          db.createObjectStore('tafsir_cache', { keyPath: 'key' }); // key: `${tafsirId}_${verseKey}`
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  getSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('moshafi_settings') || '{}');
      return { ...DEFAULT_STATE, ...saved };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  saveSettings(partial) {
    const current = this.getSettings();
    const updated = { ...current, ...partial };
    localStorage.setItem('moshafi_settings', JSON.stringify(updated));
    return updated;
  }

  async putRecord(storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async putMany(storeName, values) {
    if (!values.length) return true;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const st = tx.objectStore(storeName);
      values.forEach(v => st.put(v));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearStore(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getRecord(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async getAllRecords(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteRecord(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveAudioBlob(audioUrl, blob) {
    const cache = await caches.open(AUDIO_CACHE_NAME);
    const response = new Response(blob, {
      headers: { 'Content-Type': blob.type || 'audio/mpeg' }
    });
    await cache.put(audioUrl, response);
  }

  async saveAudioResponse(audioUrl, response) {
    const cache = await caches.open(AUDIO_CACHE_NAME);
    await cache.put(audioUrl, response);
  }

  async getOfflineAudioUrl(audioUrl) {
    if (!audioUrl) return null;
    const cache = await caches.open(AUDIO_CACHE_NAME);
    const match = await cache.match(audioUrl);
    if (!match) return null;
    const blob = await match.blob();
    return URL.createObjectURL(blob);
  }

  async deleteOfflineAudio(audioUrl) {
    if (!audioUrl) return;
    const cache = await caches.open(AUDIO_CACHE_NAME);
    await cache.delete(audioUrl);
  }

  async clearAllOfflineData() {
    const packages = await this.getAllRecords('surah_packages');
    for (const pkg of packages) {
      if (pkg.audioUrl) await this.deleteOfflineAudio(pkg.audioUrl);
      await this.deleteRecord('surah_packages', pkg.key);
    }
    await caches.delete(AUDIO_CACHE_NAME);
    await this.clearStore('tafsir_cache');
    await this.clearStore('pages_cache');
  }

  async estimateStorageUsage() {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const usedMB = ((est.usage || 0) / (1024 * 1024)).toFixed(2);
      const quotaMB = ((est.quota || 0) / (1024 * 1024)).toFixed(0);
      return { usedMB, quotaMB };
    }
    return { usedMB: '0', quotaMB: 'غير متاح' };
  }
}
