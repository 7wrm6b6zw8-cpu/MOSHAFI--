import { API_BASE } from './config.js';

export const VERSE_FIELDS = 'text_uthmani,text_imlaei_simple,chapter_id,verse_key,verse_number,juz_number,hizb_number,page_number';

// جلب مع مهلة وإعادة محاولة (أخطاء الشبكة المؤقتة، 429، 5xx). أخطاء 4xx الأخرى لا تُعاد.
async function fetchWithRetry(url, { tries = 3, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
      lastErr.status = res.status;
      if (res.status !== 429 && res.status < 500) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status !== 429 && e.status < 500) throw e;
    } finally {
      clearTimeout(timer);
    }
    if (i < tries - 1) await new Promise(r => setTimeout(r, 700 * (i + 1)));
  }
  throw lastErr;
}

// جلب صفحة كاملة (per_page=50 حتى لا تُقطع الصفحات الطويلة) وتخزينها في pages_cache
export async function fetchPageVerses(pageNumber) {
  const url = `${API_BASE}/verses/by_page/${pageNumber}?language=ar&words=true&word_fields=text_uthmani,char_type_name&fields=${VERSE_FIELDS}&per_page=50`;
  const res = await fetchWithRetry(url);
  const data = await res.json();
  const verses = data.verses || [];
  if (!verses.length) throw new Error('صفحة فارغة');
  return verses;
}

const PAGE_CACHE_VERSION = 2; // الإصدار 1 كان بدون per_page فقد تكون الصفحة مقطوعة

export async function getPageVerses(storage, pageNumber) {
  // فشل قراءة/كتابة التخزين المحلي (IndexedDB) لا يجب أن يمنع عرض الصفحة والإنترنت شغال
  let cached = null;
  try { cached = await storage.getRecord('pages_cache', pageNumber); } catch {}
  if (cached?.v === PAGE_CACHE_VERSION && cached.verses?.length) return cached.verses;
  try {
    const verses = await fetchPageVerses(pageNumber);
    try {
      await storage.putRecord('pages_cache', { pageNumber, verses, v: PAGE_CACHE_VERSION, savedAt: Date.now() });
    } catch {}
    return verses;
  } catch (err) {
    if (cached?.verses?.length) return cached.verses; // أفضل المتاح بدون إنترنت
    throw err;
  }
}

// آيات سورة كاملة: الـ API يحدّ per_page بـ 50، فنمشي على الصفحات حتى النهاية
export async function fetchChapterVerses(surahId) {
  const all = [];
  let page = 1;
  while (page) {
    const url = `${API_BASE}/verses/by_chapter/${surahId}?language=ar&words=true&word_fields=text_uthmani,char_type_name&fields=${VERSE_FIELDS}&per_page=50&page=${page}`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    all.push(...(data.verses || []));
    page = data.pagination?.next_page || null;
  }
  return all;
}
