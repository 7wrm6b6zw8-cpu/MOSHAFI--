import { API_BASE } from './config.js';
import { escapeHtml } from './data.js';

export class SearchManager {
  constructor(storage, chapters, onOpenResult) {
    this.storage = storage;
    this.chapters = chapters;
    this.onOpenResult = onOpenResult;
  }

  init() {
    const input = document.getElementById('search-query-input');
    const btn = document.getElementById('btn-execute-search');

    btn.addEventListener('click', () => this.executeSearch());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.executeSearch();
    });
  }

  // daggerAsAlef: النص العثماني يكتب الألف بعلامة خنجرية (ـٰ)، فنحوّلها لألف حتى يطابق "العالمين"
  normalizeArabic(text, daggerAsAlef = false) {
    let t = (text || '');
    if (daggerAsAlef) t = t.replace(/\u0670/g, 'ا');
    return t
      .replace(/\u0640/g, '')                       // التطويل
      .replace(/[\u064B-\u065F\u0670]/g, '')        // التشكيل والألف الخنجرية
      .replace(/[\u06D6-\u06ED\u08D3-\u08FF]/g, '') // علامات الوقف والضبط القرآنية
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/ؤ/g, 'و')
      .replace(/ئ/g, 'ي')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async executeSearch() {
    const query = document.getElementById('search-query-input').value.trim();
    const scope = document.getElementById('search-scope-select').value;
    const statusEl = document.getElementById('search-status');
    const resultsEl = document.getElementById('search-results-list');

    if (!query) {
      statusEl.textContent = 'اكتب كلمة أو اسم سورة أو رقم آية مثل 2:255 للبحث.';
      return;
    }

    resultsEl.innerHTML = '';
    statusEl.textContent = 'جارٍ البحث...';
    const results = [];

    // 1. Check Surah name match
    const normQ = this.normalizeArabic(query);
    for (const ch of this.chapters) {
      if (this.normalizeArabic(ch.name_arabic).includes(normQ) || String(ch.id) === query) {
        results.push({
          type: 'surah',
          title: `سورة ${ch.name_arabic} (سورة رقم ${ch.id})`,
          snippet: `عدد الآيات: ${ch.verses_count} — تبدأ في الصفحة ${ch.pages?.[0] || 1}`,
          surahId: ch.id,
          page: ch.pages?.[0] || 1,
          verseKey: `${ch.id}:1`
        });
      }
    }

    // 2. Check direct verse reference (e.g., 2:255)
    if (/^\d{1,3}:\d{1,3}$/.test(query)) {
      const [sId, aNum] = query.split(':').map(Number);
      const ch = this.chapters.find(c => c.id === sId);
      if (ch && aNum >= 1 && aNum <= ch.verses_count) {
        results.push({
          type: 'verse_ref',
          title: `انتقال مباشر إلى الآية (${query}) — سورة ${ch.name_arabic}`,
          snippet: 'اضغط للانتقال مباشرة إلى موضع الآية في المصحف',
          surahId: sId,
          verseKey: query
        });
      }
    }

    // 3. Offline local search (IndexedDB packages + pages + tafsir)
    const packages = await this.storage.getAllRecords('surah_packages');
    for (const pkg of packages) {
      for (const v of pkg.verses || []) {
        const normText = v.text_imlaei_simple
          ? this.normalizeArabic(v.text_imlaei_simple)
          : this.normalizeArabic(v.text_uthmani, true);
        if (normText.includes(normQ)) {
          results.push({
            type: 'offline_verse',
            title: `سورة ${pkg.surahName} — الآية ${v.verse_key} (محفوظ محليًا)`,
            snippet: v.text_uthmani,
            surahId: pkg.surahId,
            page: v.page_number,
            verseKey: v.verse_key
          });
        }
      }
    }

    const seen = new Set(results.filter(r => r.type === 'offline_verse').map(r => r.verseKey));
    const cachedPages = await this.storage.getAllRecords('pages_cache');
    for (const pg of cachedPages) {
      for (const v of pg.verses || []) {
        if (seen.has(v.verse_key)) continue;
        const normText = v.text_imlaei_simple
          ? this.normalizeArabic(v.text_imlaei_simple)
          : this.normalizeArabic(v.text_uthmani, true);
        if (normText.includes(normQ)) {
          seen.add(v.verse_key);
          results.push({ type: 'offline_verse', title: `الآية ${v.verse_key} (محفوظة محليًا)`, snippet: v.text_uthmani, page: pg.pageNumber, verseKey: v.verse_key });
        }
      }
    }

    // scope: 'quran' = نص القرآن فقط (بدون تفسير)، 'all' = قرآن وتفسير، 'offline' = محلي فقط
    if (scope !== 'quran') {
      const tafsirs = await this.storage.getAllRecords('tafsir_cache');
      for (const t of tafsirs) {
        if (this.normalizeArabic(t.text).includes(normQ)) {
          results.push({
            type: 'offline_tafsir',
            title: `تفسير الآية ${t.verseKey} (محفوظ محليًا)`,
            snippet: t.text.slice(0, 180) + '...',
            verseKey: t.verseKey
          });
        }
      }
    }

    // 4. Online Quran.com Search API when connected and scope !== 'offline'
    if (navigator.onLine && scope !== 'offline') {
      try {
        const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}&size=20&language=ar`);
        if (res.ok) {
          const data = await res.json();
          const apiResults = data?.search?.results || [];
          for (const r of apiResults) {
            if (!results.some(existing => existing.verseKey === r.verse_key)) {
              results.push({
                type: 'api_verse',
                title: `الآية ${r.verse_key}`,
                snippet: r.text,
                verseKey: r.verse_key
              });
            }
          }
        }
      } catch {
        // Fallback silently to local results
      }
    }

    statusEl.textContent = `تم العثور على ${results.length} نتيجة.`;
    if (results.length === 0) {
      resultsEl.innerHTML = '<p class="empty-state">لم يتم العثور على نتائج مطابقة.</p>';
      return;
    }

    resultsEl.innerHTML = results.map((r, idx) => `
      <div class="result-item">
        <div>
          <strong>${escapeHtml(r.title)}</strong>
          <div class="result-arabic">${escapeHtml(r.snippet)}</div>
        </div>
        <button class="btn btn-primary btn-sm" data-res-idx="${idx}" type="button">
          <span>فتح في المصحف</span>
        </button>
      </div>
    `).join('');

    resultsEl.querySelectorAll('[data-res-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = results[parseInt(btn.dataset.resIdx, 10)];
        this.onOpenResult(item);
      });
    });
  }
}
