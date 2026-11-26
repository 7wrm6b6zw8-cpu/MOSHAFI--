import { API_BASE } from './config.js';
import { JUZ_START } from './data.js';
import { getPageVerses } from './quran-api.js';

export class MushafManager {
  constructor(storage, tafsirManager, onSelectVerseForAudio, onNotify) {
    this.storage = storage;
    this.tafsirManager = tafsirManager;
    this.onSelectVerseForAudio = onSelectVerseForAudio;
    this.onNotify = onNotify;

    this.chapters = [];
    this.currentPage = 1;
    this.currentSurah = 1;
    this.mode = 'page'; // 'page' | 'verse'
    this.selectedVerseKey = null;
    this.pageVerses = [];
    this.activePlayingVerseKey = null;
    this.loadSeq = 0;
  }

  async init(chapters) {
    this.chapters = chapters;
    const settings = this.storage.getSettings();
    this.mode = settings.mushafMode || 'page';
    this.currentPage = settings.lastReading?.page || 1;
    this.currentSurah = settings.lastReading?.surah || 1;
    this.bindEvents();
    this.updateModeButtons();
    return this.loadPage(this.currentPage, settings.lastReading?.ayah ? `${this.currentSurah}:${settings.lastReading.ayah}` : null);
  }

  bindEvents() {
    // أدوات القارئ (تظهر عند الطلب فقط حتى تبقى الصفحة كاملة)
    const toolsBtn = document.getElementById('btn-reader-tools');
    toolsBtn.addEventListener('click', () => {
      const panel = document.getElementById('reader-tools');
      const open = panel.classList.toggle('hidden') === false;
      toolsBtn.setAttribute('aria-expanded', String(open));
      requestAnimationFrame(() => this.fitPage());
    });

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.fitPage(), 120);
    });

    document.getElementById('btn-mode-page').addEventListener('click', () => this.setMode('page'));
    document.getElementById('btn-mode-verse').addEventListener('click', () => this.setMode('verse'));

    document.getElementById('btn-prev-page').addEventListener('click', () => {
      if (this.currentPage > 1) this.loadPage(this.currentPage - 1);
    });

    document.getElementById('btn-next-page').addEventListener('click', () => {
      if (this.currentPage < 604) this.loadPage(this.currentPage + 1);
    });

    document.getElementById('btn-go-page').addEventListener('click', () => {
      const p = parseInt(document.getElementById('mushaf-page-input').value, 10);
      if (p >= 1 && p <= 604) this.loadPage(p);
    });

    document.getElementById('mushaf-surah-select').addEventListener('change', (e) => {
      const surahId = parseInt(e.target.value, 10);
      const ch = this.chapters.find(c => c.id === surahId);
      if (ch && ch.pages && ch.pages[0]) {
        this.loadPage(ch.pages[0], `${surahId}:1`);
      }
    });

    document.getElementById('mushaf-juz-select').addEventListener('change', async (e) => {
      const juzNum = parseInt(e.target.value, 10);
      await this.goToJuz(juzNum);
    });

    document.getElementById('btn-close-tafsir').addEventListener('click', () => {
      document.getElementById('inline-tafsir-panel').classList.add('hidden');
      document.querySelector('.mushaf-workspace').classList.remove('with-tafsir');
    });

    document.getElementById('tafsir-source-select').addEventListener('change', (e) => {
      const tafsirId = parseInt(e.target.value, 10);
      this.storage.saveSettings({ tafsirId });
      if (this.selectedVerseKey) {
        const vObj = this.pageVerses.find(v => v.verse_key === this.selectedVerseKey);
        this.openVerseTafsir(this.selectedVerseKey, vObj?.text_uthmani || '');
      }
    });

    document.getElementById('btn-play-selected-verse').addEventListener('click', () => {
      if (this.selectedVerseKey && this.onSelectVerseForAudio) {
        this.onSelectVerseForAudio(this.selectedVerseKey);
      }
    });

    document.getElementById('btn-fav-selected-verse').addEventListener('click', () => {
      if (!this.selectedVerseKey) return;
      const vObj = this.pageVerses.find(v => v.verse_key === this.selectedVerseKey);
      this.addFavoriteVerse(this.selectedVerseKey, vObj?.text_uthmani || '');
    });

    document.getElementById('btn-bookmark-page').addEventListener('click', () => {
      this.addPageBookmark(this.currentPage);
    });

    // Swipe navigation on mobile/tablet
    let touchStartX = 0;
    const readerEl = document.getElementById('mushaf-content');
    readerEl.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });
    readerEl.addEventListener('touchend', (e) => {
      const diff = e.changedTouches[0].screenX - touchStartX;
      // In RTL: swipe right -> next page, swipe left -> prev page
      if (diff > 65 && this.currentPage < 604) {
        this.loadPage(this.currentPage + 1);
      } else if (diff < -65 && this.currentPage > 1) {
        this.loadPage(this.currentPage - 1);
      }
    }, { passive: true });
  }

  setMode(mode) {
    this.mode = mode;
    this.storage.saveSettings({ mushafMode: mode });
    this.updateModeButtons();
    this.renderPage();
  }

  updateModeButtons() {
    document.getElementById('btn-mode-page').classList.toggle('active', this.mode === 'page');
    document.getElementById('btn-mode-verse').classList.toggle('active', this.mode === 'verse');
  }

  async goToJuz(juzNumber) {
    const entry = JUZ_START[juzNumber - 1];
    if (!entry) return;
    await this.loadPage(entry[0], entry[1]);
  }

  // صفحة الآية: من الكاش المحلي أولًا، ثم الشبكة، ثم بداية السورة
  async findVerseKeyPage(verseKey) {
    const [sId, aNum] = verseKey.split(':').map(Number);
    const ch = this.chapters.find(c => c.id === sId);
    if (!ch) return 1;
    const [from, to] = ch.pages;
    for (let p = from; p <= to; p++) {
      const rec = await this.storage.getRecord('pages_cache', p);
      if (rec?.verses?.some(v => v.verse_key === verseKey)) return p;
    }
    if (navigator.onLine) {
      try {
        const res = await fetch(`${API_BASE}/verses/by_key/${verseKey}`);
        if (res.ok) {
          const data = await res.json();
          if (data?.verse?.page_number) return data.verse.page_number;
        }
      } catch {}
    }
    // تقدير تقريبي داخل نطاق صفحات السورة إذا لم تتوفر بيانات
    if (aNum > 1 && to > from) return Math.min(to, from + Math.floor(((aNum - 1) / ch.verses_count) * (to - from + 1)));
    return from;
  }

  async loadPage(pageNumber, highlightVerseKey = null) {
    this.currentPage = Math.max(1, Math.min(604, pageNumber));
    document.getElementById('mushaf-page-input').value = this.currentPage;
    document.getElementById('pagination-indicator').textContent = `صفحة ${this.currentPage} / 604`;
    document.getElementById('meta-page-num').textContent = `صفحة ${this.currentPage}`;

    const container = document.getElementById('mushaf-content');
    container.innerHTML = '<div class="loading-state">جارٍ تحميل الصفحة بالرسم العثماني الموثق...</div>';

    const seq = ++this.loadSeq;
    let verses;
    try {
      verses = await getPageVerses(this.storage, this.currentPage);
    } catch {
      if (seq === this.loadSeq) {
        container.innerHTML = '<div class="notice-bar">هذه الصفحة غير محفوظة محليًا وأنت غير متصل بالإنترنت حاليًا. نزّل السورة من قسم التنزيلات لتصبح صفحاتها متاحة بدون إنترنت.</div>';
      }
      return;
    }
    if (seq !== this.loadSeq) return; // وصل طلب أحدث

    this.pageVerses = verses;
    if (verses.length > 0) {
      const first = verses[0];
      this.currentSurah = first.chapter_id;
      const ch = this.chapters.find(c => c.id === first.chapter_id);
      document.getElementById('meta-surah-name').textContent = ch ? `سورة ${ch.name_arabic}` : `سورة ${first.chapter_id}`;
      document.getElementById('meta-juz-info').textContent = `الجزء ${first.juz_number}`;
      document.getElementById('mushaf-surah-select').value = first.chapter_id;
      document.getElementById('mushaf-juz-select').value = first.juz_number;

      this.storage.saveSettings({
        lastReading: {
          surah: first.chapter_id,
          ayah: first.verse_number,
          page: this.currentPage
        }
      });
    }

    this.renderPage(highlightVerseKey);

    // الصفحة تُحتسب مقروءة بعد 15 ثانية من فتحها
    clearTimeout(this.readTimer);
    const viewed = this.currentPage;
    this.readTimer = setTimeout(() => this.onPageViewed && this.onPageViewed(viewed), 15000);
  }

  toArabicDigits(num) {
    return String(num).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
  }

  renderPage(highlightVerseKey = null) {
    const container = document.getElementById('mushaf-content');
    if (!this.pageVerses || this.pageVerses.length === 0) return;

    let html = '';
    let lastChapter = null;

    if (this.mode === 'page') {
      for (const v of this.pageVerses) {
        if (v.chapter_id !== lastChapter) {
          lastChapter = v.chapter_id;
          if (v.verse_number === 1) {
            const ch = this.chapters.find(c => c.id === v.chapter_id);
            html += `<div class="surah-banner-ornament">سُورَةُ ${ch ? ch.name_arabic : ''}</div>`;
            if (v.chapter_id !== 1 && v.chapter_id !== 9) {
              html += `<div class="bismillah-line">بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ</div>`;
            }
          }
        }
        const isActive = (highlightVerseKey === v.verse_key || this.activePlayingVerseKey === v.verse_key) ? 'active-ayah' : '';
        html += `<span class="ayah-inline ${isActive}" data-verse-key="${v.verse_key}" title="اضغط لعرض التفسير وخيارات الآية">${v.text_uthmani} <span class="ayah-end-symbol">﴿${this.toArabicDigits(v.verse_number)}﴾</span> </span>`;
      }
    } else {
      for (const v of this.pageVerses) {
        if (v.chapter_id !== lastChapter) {
          lastChapter = v.chapter_id;
          if (v.verse_number === 1) {
            const ch = this.chapters.find(c => c.id === v.chapter_id);
            html += `<div class="surah-banner-ornament">سُورَةُ ${ch ? ch.name_arabic : ''}</div>`;
            if (v.chapter_id !== 1 && v.chapter_id !== 9) {
              html += `<div class="bismillah-line">بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ</div>`;
            }
          }
        }
        const isActive = (highlightVerseKey === v.verse_key || this.activePlayingVerseKey === v.verse_key) ? 'active-ayah' : '';
        html += `
          <div class="ayah-card-item ${isActive}" data-verse-key="${v.verse_key}">
            <div class="ayah-card-header">
              <span>الآية ${v.verse_key}</span>
              <div class="ayah-card-actions">
                <button class="btn btn-outline btn-sm btn-verse-tafsir" data-verse-key="${v.verse_key}" type="button"><span>التفسير</span></button>
                <button class="btn btn-primary btn-sm btn-verse-play" data-verse-key="${v.verse_key}" type="button"><span>استماع</span></button>
              </div>
            </div>
            <div class="ayah-card-body">${v.text_uthmani} <span class="ayah-end-symbol">﴿${this.toArabicDigits(v.verse_number)}﴾</span></div>
          </div>
        `;
      }
    }

    container.innerHTML = html;
    container.classList.toggle('mode-verse', this.mode === 'verse');
    container.style.fontSize = '';
    container.scrollTop = 0;
    if (this.mode === 'page') {
      this.fitPage();
      document.fonts?.ready?.then(() => this.fitPage());
    }

    // Bind clicks on verses
    container.querySelectorAll('[data-verse-key]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.btn-verse-play')) {
          const vk = e.target.closest('.btn-verse-play').dataset.verseKey;
          this.onSelectVerseForAudio(vk);
          return;
        }
        const vk = el.dataset.verseKey;
        const vObj = this.pageVerses.find(item => item.verse_key === vk);
        this.openVerseTafsir(vk, vObj?.text_uthmani || '');
      });
    });

    if (highlightVerseKey) {
      const targetEl = container.querySelector(`[data-verse-key="${highlightVerseKey}"]`);
      if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // يضبط حجم الخط ليظهر نص الصفحة كاملًا في الشاشة بدون تمرير، مثل المصحف الورقي
  fitPage() {
    const el = document.getElementById('mushaf-content');
    if (!el || this.mode !== 'page' || !el.querySelector('.ayah-inline')) return;
    if (el.clientHeight < 120) return; // القسم مخفي حاليًا
    let lo = 12, hi = 34, best = 12;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = `${mid}px`;
      if (el.scrollHeight <= el.clientHeight + 1) { best = mid; lo = mid; } else { hi = mid; }
    }
    el.style.fontSize = `${best}px`;
  }

  highlightPlayingVerse(verseKey) {
    this.activePlayingVerseKey = verseKey;
    const container = document.getElementById('mushaf-content');
    container.querySelectorAll('.active-ayah').forEach(el => el.classList.remove('active-ayah'));
    const target = container.querySelector(`[data-verse-key="${verseKey}"]`);
    if (target) {
      target.classList.add('active-ayah');
    }
  }

  async openVerseTafsir(verseKey, arabicText) {
    this.selectedVerseKey = verseKey;
    const workspace = document.querySelector('.mushaf-workspace');
    const panel = document.getElementById('inline-tafsir-panel');
    workspace.classList.add('with-tafsir');
    panel.classList.remove('hidden');

    const settings = this.storage.getSettings();
    const tafsirId = parseInt(document.getElementById('tafsir-source-select').value || settings.tafsirId || 16, 10);

    document.getElementById('tafsir-verse-title').textContent = `تفسير الآية (${verseKey})`;
    document.getElementById('tafsir-verse-arabic').textContent = arabicText;
    document.getElementById('tafsir-body-text').textContent = 'جارٍ تحميل التفسير الموثق...';

    const result = await this.tafsirManager.getAyahTafsir(verseKey, tafsirId);
    document.getElementById('tafsir-source-badge').textContent = result.sourceName;
    document.getElementById('tafsir-body-text').textContent = result.text;
  }

  addPageBookmark(page) {
    const settings = this.storage.getSettings();
    const ch = this.chapters.find(c => c.id === this.currentSurah);
    const list = settings.pageBookmarks || [];
    if (list.some(b => b.page === page)) {
      this.onNotify(`الصفحة ${page} محفوظة بالفعل في العلامات المرجعية.`);
      return;
    }
    list.unshift({
      page,
      surahName: ch ? ch.name_arabic : '',
      createdAt: new Date().toLocaleDateString('ar-EG')
    });
    this.storage.saveSettings({ pageBookmarks: list });
    this.onNotify(`تم حفظ علامة مرجعية للصفحة ${page}.`);
  }

  addFavoriteVerse(verseKey, arabicText) {
    const settings = this.storage.getSettings();
    const list = settings.favoriteVerses || [];
    if (list.some(f => f.verseKey === verseKey)) {
      this.onNotify(`الآية ${verseKey} موجودة بالفعل في المفضلة.`);
      return;
    }
    list.unshift({
      verseKey,
      arabicText,
      note: '',
      createdAt: new Date().toLocaleDateString('ar-EG')
    });
    this.storage.saveSettings({ favoriteVerses: list });
    this.onNotify(`تم حفظ الآية ${verseKey} في المفضلة.`);
  }
}
