import { API_BASE } from './config.js';

export const TAFSIR_SOURCES = {
  16: 'التفسير الميسر (مجمع الملك فهد)',
  14: 'تفسير ابن كثير',
  15: 'تفسير الطبري',
  91: 'تفسير السعدي'
};

// أسماء ملفات المصدر الاحتياطي (spa5k/tafsir_api عبر jsDelivr)
const TAFSIR_SLUGS = {
  16: 'ar-tafsir-muyassar',
  14: 'ar-tafsir-ibn-kathir',
  15: 'ar-tafsir-al-tabari',
  91: 'ar-tafseer-al-saddi'
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

  async fetchJson(url, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  // المصدر 1: Quran.com API — المصدر 2 (احتياطي): ملفات تفسير ثابتة على jsDelivr
  async fetchTafsirText(verseKey, tafsirId) {
    const errors = [];
    try {
      const data = await this.fetchJson(`${API_BASE}/tafsirs/${tafsirId}/by_ayah/${verseKey}`);
      const text = this.cleanHtml(data?.tafsir?.text || '').trim();
      if (text) return text;
      errors.push('API: نص فارغ');
    } catch (e) { errors.push(`API: ${e.message}`); }

    const slug = TAFSIR_SLUGS[tafsirId];
    if (slug) {
      const [surah, ayah] = verseKey.split(':');
      try {
        const data = await this.fetchJson(`https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/${slug}/${surah}/${ayah}.json`);
        const text = this.cleanHtml(data?.text || '').trim();
        if (text) return text;
        errors.push('CDN: نص فارغ');
      } catch (e) { errors.push(`CDN: ${e.message}`); }
    }
    const err = new Error(errors.join(' | '));
    err.details = errors;
    throw err;
  }

  async getAyahTafsir(verseKey, tafsirId = 16) {
    const sourceName = TAFSIR_SOURCES[tafsirId] || 'تفسير موثق';
    const cacheKey = `${tafsirId}_${verseKey}`;

    // 1) المخزّن محليًا (يعمل بدون إنترنت)
    try {
      const cached = await this.storage.getRecord('tafsir_cache', cacheKey);
      if (cached && cached.text) return { verseKey, tafsirId, sourceName, text: cached.text, offline: true };
    } catch {}

    // 2) من الإنترنت
    try {
      const text = await this.fetchTafsirText(verseKey, tafsirId);
      try {
        await this.storage.putRecord('tafsir_cache', { key: cacheKey, verseKey, tafsirId, text, updatedAt: Date.now() });
      } catch {}
      return { verseKey, tafsirId, sourceName, text, offline: false };
    } catch (err) {
      const reason = navigator.onLine
        ? `تعذّر تحميل التفسير الآن، سنعيد المحاولة تلقائيًا.\n(تفاصيل: ${err.message})`
        : 'لا يوجد اتصال بالإنترنت، ولم يُنزَّل تفسير هذه الآية. نزّل السورة من «المزيد ← التنزيلات» لقراءة التفسير بدون إنترنت.';
      return { verseKey, tafsirId, sourceName, text: reason, offline: !navigator.onLine, error: true };
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
