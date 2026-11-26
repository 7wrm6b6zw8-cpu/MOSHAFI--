import { API_BASE } from './config.js';

export const VERSE_FIELDS = 'text_uthmani,text_imlaei_simple,chapter_id,verse_key,verse_number,juz_number,hizb_number,page_number';

// جلب صفحة كاملة (per_page=50 حتى لا تُقطع الصفحات الطويلة) وتخزينها في pages_cache
export async function fetchPageVerses(pageNumber) {
  const url = `${API_BASE}/verses/by_page/${pageNumber}?language=ar&words=true&word_fields=text_uthmani,char_type_name&fields=${VERSE_FIELDS}&per_page=50`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('فشل تحميل الصفحة');
  const data = await res.json();
  const verses = data.verses || [];
  if (!verses.length) throw new Error('صفحة فارغة');
  return verses;
}

const PAGE_CACHE_VERSION = 2; // الإصدار 1 كان بدون per_page فقد تكون الصفحة مقطوعة

export async function getPageVerses(storage, pageNumber) {
  const cached = await storage.getRecord('pages_cache', pageNumber);
  if (cached?.v === PAGE_CACHE_VERSION && cached.verses?.length) return cached.verses;
  try {
    const verses = await fetchPageVerses(pageNumber);
    await storage.putRecord('pages_cache', { pageNumber, verses, v: PAGE_CACHE_VERSION, savedAt: Date.now() });
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
    const res = await fetch(url);
    if (!res.ok) throw new Error('فشل جلب آيات السورة');
    const data = await res.json();
    all.push(...(data.verses || []));
    page = data.pagination?.next_page || null;
  }
  return all;
}
