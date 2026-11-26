import { API_BASE } from './config.js';

export const TAFSIR_SOURCES = {
  16: 'التفسير الميسر (مجمع الملك فهد)',
  14: 'تفسير ابن كثير',
  15: 'تفسير الطبري',
  91: 'تفسير السعدي'
};

export class TafsirManager {
  constructor(storage) {
    this.storage = storage;
  }

  cleanHtml(rawHtml) {
    if (!rawHtml) return '';
    // DOMParser لا ينفّذ سكربتات ولا يحمّل صورًا، بخلاف innerHTML على عنصر منفصل
    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
    return doc.body.textContent || '';
  }

  async getAyahTafsir(verseKey, tafsirId = 16) {
    const cacheKey = `${tafsirId}_${verseKey}`;
    // 1. Check IndexedDB first (works offline & speeds up repeated access)
    const cached = await this.storage.getRecord('tafsir_cache', cacheKey);
    if (cached && cached.text) {
      return {
        verseKey,
        tafsirId,
        sourceName: TAFSIR_SOURCES[tafsirId] || 'تفسير موثق',
        text: cached.text,
        offline: true
      };
    }

    // 2. Fetch from official Quran.com API v4
    try {
      const url = `${API_BASE}/tafsirs/${tafsirId}/by_ayah/${encodeURIComponent(verseKey)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('تعذر جلب التفسير من المصدر');
      const data = await res.json();
      const rawText = data?.tafsir?.text || '';
      const cleanText = this.cleanHtml(rawText).trim() || 'لا يتوفر نص تفسير لهذه الآية في المصدر المختار.';

      await this.storage.putRecord('tafsir_cache', {
        key: cacheKey,
        verseKey,
        tafsirId,
        text: cleanText,
        updatedAt: Date.now()
      });

      return {
        verseKey,
        tafsirId,
        sourceName: TAFSIR_SOURCES[tafsirId] || 'تفسير موثق',
        text: cleanText,
        offline: false
      };
    } catch (err) {
      return {
        verseKey,
        tafsirId,
        sourceName: TAFSIR_SOURCES[tafsirId] || 'تفسير موثق',
        text: 'أنت غير متصل بالإنترنت ولم يتم تنزيل تفسير هذه السورة مسبقًا. يمكنك تنزيل السورة من قسم التنزيلات لقراءة التفسير بدون إنترنت.',
        offline: true,
        error: true
      };
    }
  }

  async downloadSurahTafsir(surahId, tafsirId = 16) {
    const url = `${API_BASE}/tafsirs/${tafsirId}/by_chapter/${surahId}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const list = data?.tafsirs || [];
    const records = [];
    for (const item of list) {
      const vKey = item.verse_key;
      const cleanText = this.cleanHtml(item.text || '').trim();
      if (vKey && cleanText) {
        records.push({ key: `${tafsirId}_${vKey}`, verseKey: vKey, tafsirId, text: cleanText, updatedAt: Date.now() });
      }
    }
    await this.storage.putMany('tafsir_cache', records);
    return list;
  }

  // تنزيل كل مصادر التفسير للسورة حتى لا يتوقف التفسير عند تغيير المصدر
  async downloadSurahAllTafsirs(surahId) {
    for (const id of Object.keys(TAFSIR_SOURCES)) {
      try { await this.downloadSurahTafsir(surahId, Number(id)); } catch {}
    }
  }

  // تحميل خلفي لتفسير السورة مرة واحدة بدل طلب لكل آية
  async prefetchSurah(surahId, tafsirId) {
    this._prefetched = this._prefetched || new Set();
    const k = `${tafsirId}_${surahId}`;
    if (this._prefetched.has(k) || !navigator.onLine) return;
    this._prefetched.add(k);
    try { await this.downloadSurahTafsir(surahId, tafsirId); } catch { this._prefetched.delete(k); }
  }
}
