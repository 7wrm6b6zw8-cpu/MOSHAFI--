import { StorageManager } from './storage.js';
import { TafsirManager } from './tafsir.js';
import { WordSyncEngine } from './word-sync.js';
import { MushafManager } from './mushaf.js';
import { AudioPlayerManager, VERIFIED_RECITERS } from './audio.js';
import { SearchManager } from './search.js';

import { CHAPTERS, escapeHtml as esc, normalizeArabic } from './data.js';
import { ProgressTracker } from './progress.js';

class MoshafiApp {
  constructor() {
    this.storage = new StorageManager();
    this.tafsirManager = new TafsirManager(this.storage);
    this.wordSync = new WordSyncEngine();
    this.progress = new ProgressTracker(this.storage);
    this.chapters = [];
  }

  async init() {
    await this.storage.init();
    this.registerServiceWorker();
    this.loadChapters(); // ثابتة محليًا، لا تنتظر الشبكة
    this.applySettingsToUI();
    this.setupNetworkListeners();
    this.setupPWAInstall();
    this.setupHistory();

    this.mushaf = new MushafManager(
      this.storage,
      this.tafsirManager,
      (verseKey) => {
        const [sId, aNum] = verseKey.split(':').map(Number);
        this.player.loadAndPlaySurah(sId, aNum);
      },
      (msg) => this.showToast(msg)
    );

    this.player = new AudioPlayerManager(
      this.storage,
      this.tafsirManager,
      this.wordSync,
      (verseKey) => this.mushaf.highlightPlayingVerse(verseKey),
      (verseKey) => this.jumpToVerseInMushaf(verseKey),
      (msg) => this.showToast(msg)
    );

    this.search = new SearchManager(
      this.storage,
      this.chapters,
      (item) => this.handleSearchResultClick(item)
    );

    // الواجهة أولًا: القوائم ثم ربط الأحداث، قبل أي عملية تعتمد على الشبكة
    this.populateSelectors();
    this.renderHomeSurahs();
    this.renderListenSurahs();
    this.renderBookmarksView();
    this.bindGlobalEvents();
    this.injectExtras();
    this.mushaf.onPageViewed = (page) => this.onPageRead(page);
    this.player.init(this.chapters);
    this.search.init();

    this.refreshDownloadsView().catch(() => {});
    this.mushaf.init(this.chapters).catch(() => {
      this.showToast('تعذر تحميل الصفحة. يمكنك التنقل بين الصفحات والسور.');
    });
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  setupNetworkListeners() {
    const updateBadge = () => {
      const badge = document.getElementById('connection-badge');
      if (navigator.onLine) {
        badge.textContent = 'متصل بالشبكة';
        badge.className = 'badge badge-online';
      } else {
        badge.textContent = 'وضع بدون إنترنت';
        badge.className = 'badge badge-offline';
      }
    };
    window.addEventListener('online', updateBadge);
    window.addEventListener('offline', updateBadge);
    updateBadge();
  }

  setupPWAInstall() {
    let deferredPrompt = null;
    const installBtn = document.getElementById('btn-install-pwa');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.classList.remove('hidden');
    });
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.classList.add('hidden');
    });
  }

  loadChapters() {
    this.chapters = CHAPTERS;
  }

  // زر الرجوع في أندرويد: كل تبويب له مدخل في history
  setupHistory() {
    history.replaceState({ view: 'home' }, '');
    window.addEventListener('popstate', (e) => {
      const modal = document.getElementById('app-modal');
      modal.classList.add('hidden');
      this.switchView(e.state?.view || 'home', false);
    });
  }

  // الشاشة تظل مضاءة أثناء القراءة فقط (إن كان المتصفح يدعم Wake Lock)
  async updateWakeLock() {
    if (!('wakeLock' in navigator)) return;
    const reading = document.getElementById('view-mushaf')?.classList.contains('active') && !document.hidden;
    try {
      if (reading && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      } else if (!reading && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {}
  }

  applySettingsToUI() {
    const s = this.storage.getSettings();
    document.documentElement.setAttribute('data-theme', s.theme);
    document.documentElement.style.setProperty('--quran-font-size', `${s.quranFontSize}px`);
    document.documentElement.style.setProperty('--ui-font-size', `${s.uiFontSize}px`);
    document.body.classList.toggle('simple-mode', Boolean(s.simpleMode));

    document.getElementById('btn-simple-mode').querySelector('span').textContent =
      `الوضع المبسط: ${s.simpleMode ? 'مفعّل' : 'إيقاف'}`;
    document.getElementById('btn-theme-toggle').querySelector('span').textContent =
      s.theme === 'dark' ? 'الوضع النهاري' : 'الوضع الليلي';

    document.getElementById('setting-theme').value = s.theme;
    document.getElementById('setting-quran-font-size').value = s.quranFontSize;
    document.getElementById('lbl-quran-size').textContent = s.quranFontSize;
    document.getElementById('setting-ui-font-size').value = s.uiFontSize;
    document.getElementById('lbl-ui-size').textContent = s.uiFontSize;
    document.getElementById('setting-mushaf-mode').value = s.mushafMode;
    document.getElementById('setting-tafsir').value = s.tafsirId;
    document.getElementById('tafsir-source-select').value = s.tafsirId;
    document.getElementById('setting-playback-rate').value = s.playbackRate;
    document.getElementById('player-speed').value = s.playbackRate;
    document.getElementById('setting-simple-mode').checked = Boolean(s.simpleMode);

    // Home resume buttons
    const lastCh = this.chapters.find(c => c.id === s.lastListening?.surah);
    document.getElementById('btn-resume-reading').querySelector('span').textContent =
      `متابعة القراءة (صفحة ${s.lastReading?.page || 1})`;
    document.getElementById('btn-resume-listening').querySelector('span').textContent =
      `متابعة الاستماع (${lastCh ? 'سورة ' + lastCh.name_arabic + ' — آية ' + (s.lastListening?.ayah || 1) : 'سورة الفاتحة'})`;
  }

  populateSelectors() {
    // Mushaf Surah select
    const surahSelect = document.getElementById('mushaf-surah-select');
    surahSelect.innerHTML = this.chapters.map(c =>
      `<option value="${c.id}">${c.id}. سورة ${c.name_arabic}</option>`
    ).join('');

    // Juz select (1..30)
    const juzSelect = document.getElementById('mushaf-juz-select');
    juzSelect.innerHTML = Array.from({ length: 30 }, (_, i) =>
      `<option value="${i + 1}">الجزء ${i + 1}</option>`
    ).join('');

    // Reciters selects
    const recOptions = VERIFIED_RECITERS.map(r =>
      `<option value="${r.id}">${r.name} (${r.style})</option>`
    ).join('');
    document.getElementById('listen-reciter-select').innerHTML = recOptions;
    document.getElementById('setting-reciter').innerHTML = recOptions;

    const currentRec = this.storage.getSettings().reciterId || 7;
    document.getElementById('listen-reciter-select').value = currentRec;
    document.getElementById('setting-reciter').value = currentRec;
  }

  switchView(viewName, push = true) {
    const cur = document.querySelector('.view.active')?.id.replace('view-', '');
    if (push && cur !== viewName) history.pushState({ view: viewName }, '');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.add('active');

    this.updateWakeLock();
    if (viewName === 'bookmarks') this.renderBookmarksView();
    if (viewName === 'downloads') this.refreshDownloadsView();
  }

  renderHomeSurahs(filterText = '') {
    const quickIds = [1, 2, 18, 36, 55, 67, 112];
    const quickContainer = document.getElementById('home-quick-surahs');
    quickContainer.innerHTML = quickIds.map(id => {
      const ch = this.chapters.find(c => c.id === id);
      if (!ch) return '';
      return `<button class="btn btn-secondary btn-sm" data-open-surah="${ch.id}" type="button"><span>سورة ${ch.name_arabic}</span></button>`;
    }).join('');

    const listEl = document.getElementById('home-surah-list');
    const q = normalizeArabic(filterText);
    const filtered = this.chapters.filter(c =>
      !q || normalizeArabic(c.name_arabic).includes(q) || String(c.id) === q
    );

    listEl.innerHTML = filtered.map(c => `
      <div class="surah-card">
        <div class="surah-card-top">
          <span class="surah-number">${c.id}</span>
          <span class="surah-name-ar">سورة ${c.name_arabic}</span>
          <span class="badge">${c.verses_count} آية</span>
        </div>
        <div class="surah-card-actions">
          <button class="btn btn-primary btn-sm" data-open-surah="${c.id}" type="button"><span>قراءة</span></button>
          <button class="btn btn-gold btn-sm" data-play-surah="${c.id}" type="button"><span>استماع</span></button>
        </div>
      </div>
    `).join('');

    document.querySelectorAll('[data-open-surah]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sId = parseInt(btn.dataset.openSurah, 10);
        const ch = this.chapters.find(c => c.id === sId);
        this.switchView('mushaf');
        this.mushaf.loadPage(ch?.pages?.[0] || 1, `${sId}:1`);
      });
    });

    document.querySelectorAll('[data-play-surah]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sId = parseInt(btn.dataset.playSurah, 10);
        this.player.loadAndPlaySurah(sId, 1);
      });
    });
  }

  renderListenSurahs() {
    const listEl = document.getElementById('listen-surah-list');
    listEl.innerHTML = this.chapters.map(c => `
      <div class="surah-card">
        <div class="surah-card-top">
          <span class="surah-number">${c.id}</span>
          <span class="surah-name-ar">سورة ${c.name_arabic}</span>
          <span class="badge">${c.verses_count} آية</span>
        </div>
        <div class="surah-card-actions">
          <button class="btn btn-primary btn-sm" data-listen-surah="${c.id}" type="button"><span>تشغيل التلاوة</span></button>
          <button class="btn btn-outline btn-sm" data-dl-surah="${c.id}" type="button"><span>تنزيل</span></button>
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-listen-surah]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sId = parseInt(btn.dataset.listenSurah, 10);
        const recId = parseInt(document.getElementById('listen-reciter-select').value, 10);
        this.player.loadAndPlaySurah(sId, 1, recId);
      });
    });

    listEl.querySelectorAll('[data-dl-surah]').forEach(btn => {
      btn.addEventListener('click', () => this.triggerSurahDownload(parseInt(btn.dataset.dlSurah, 10), btn));
    });
  }

  async triggerSurahDownload(surahId, triggerBtn = null) {
    navigator.storage?.persist?.().catch(() => {});
    const recId = this.storage.getSettings().reciterId || 7;
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.querySelector('span').textContent = 'جارٍ التنزيل 0%...';
    }
    try {
      await this.player.downloadSurahForOffline(surahId, recId, (pct) => {
        if (triggerBtn) triggerBtn.querySelector('span').textContent = `${pct}%`;
      });
      this.showToast('اكتمل تنزيل السورة (الصوت + صفحات المصحف + التفسير + التوقيتات) للعمل بدون إنترنت.');
      if (triggerBtn) triggerBtn.querySelector('span').textContent = 'تم التنزيل';
      await this.refreshDownloadsView();
    } catch (err) {
      this.showToast(err?.message?.includes('CORS') ? err.message : 'تعذر إكمال التنزيل. تحقق من الاتصال بالإنترنت.');
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.querySelector('span').textContent = 'تنزيل';
      }
    }
  }

  async refreshDownloadsView() {
    const packages = await this.storage.getAllRecords('surah_packages');
    const usage = await this.storage.estimateStorageUsage();
    document.getElementById('storage-usage-text').textContent =
      `المساحة المستخدمة: ${usage.usedMB} ميجابايت (السور المحفوظة: ${packages.length})`;
    document.getElementById('home-offline-status').textContent =
      packages.length > 0
        ? `لديك ${packages.length} سورة جاهزة للعمل الكامل بدون إنترنت (المساحة: ${usage.usedMB} MB).`
        : 'لا توجد سور منزّلة حاليًا. نزّل سورك المفضلة لقراءتها والاستماع إليها بدون إنترنت.';

    this.downloadedSurahIds = new Set(packages.filter(p => p.reciterId === (this.storage.getSettings().reciterId || 7)).map(p => p.surahId));
    const dlList = document.getElementById('downloaded-surahs-list');
    if (packages.length === 0) {
      dlList.innerHTML = '<p class="empty-state">لا توجد سور منزّلة حاليًا.</p>';
    } else {
      dlList.innerHTML = packages.map(pkg => `
        <div class="download-item">
          <div>
            <strong>سورة ${esc(pkg.surahName)}</strong> — <span>${esc(pkg.reciterName)}</span>
            <div class="subtitle">الحجم: ${(pkg.sizeBytes / (1024 * 1024)).toFixed(2)} MB | تاريخ التنزيل: ${pkg.downloadedAt} | حالة: مكتمل</div>
          </div>
          <div class="surah-card-actions">
            <button class="btn btn-primary btn-sm" data-play-offline="${pkg.surahId}" data-rec="${pkg.reciterId}" type="button"><span>تشغيل</span></button>
            <button class="btn btn-danger btn-sm" data-del-pkg="${pkg.key}" type="button"><span>حذف</span></button>
          </div>
        </div>
      `).join('');

      dlList.querySelectorAll('[data-play-offline]').forEach(btn => {
        btn.addEventListener('click', () => {
          this.player.loadAndPlaySurah(parseInt(btn.dataset.playOffline, 10), 1, parseInt(btn.dataset.rec, 10));
        });
      });

      dlList.querySelectorAll('[data-del-pkg]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const key = btn.dataset.delPkg;
          const pkg = await this.storage.getRecord('surah_packages', key);
          if (pkg?.audioUrl) await this.storage.deleteOfflineAudio(pkg.audioUrl);
          await this.storage.deleteRecord('surah_packages', key);
          this.showToast('تم حذف السورة من التخزين المحلي.');
          await this.refreshDownloadsView();
        });
      });
    }

    const availEl = document.getElementById('available-downloads-list');
    availEl.innerHTML = this.chapters.map(c => `
      <div class="surah-card">
        <div class="surah-card-top">
          <span class="surah-number">${c.id}</span>
          <span class="surah-name-ar">سورة ${c.name_arabic}</span>
        </div>
        <button class="btn btn-secondary btn-sm" data-dl-pkg-surah="${c.id}" type="button"><span>تنزيل</span></button>
      </div>
    `).join('');

    availEl.querySelectorAll('[data-dl-pkg-surah]').forEach(btn => {
      btn.addEventListener('click', () => this.triggerSurahDownload(parseInt(btn.dataset.dlPkgSurah, 10), btn));
    });
    document.querySelectorAll('[data-dl-pkg-surah], [data-dl-surah]').forEach(btn => {
      const id = parseInt(btn.dataset.dlPkgSurah || btn.dataset.dlSurah, 10);
      if (this.downloadedSurahIds.has(id)) {
        btn.querySelector('span').textContent = 'منزّلة ✓';
        btn.disabled = true;
      } else if (!btn.disabled || btn.querySelector('span').textContent === 'منزّلة ✓') {
        btn.querySelector('span').textContent = 'تنزيل';
        btn.disabled = false;
      }
    });
  }

  renderBookmarksView() {
    const s = this.storage.getSettings();
    const pagesEl = document.getElementById('page-bookmarks-list');
    const favsEl = document.getElementById('favorite-verses-list');

    if (!s.pageBookmarks || s.pageBookmarks.length === 0) {
      pagesEl.innerHTML = '<p class="empty-state">لا توجد علامات مرجعية للصفحات بعد.</p>';
    } else {
      pagesEl.innerHTML = s.pageBookmarks.map((b, i) => `
        <div class="bookmark-item">
          <div>
            <strong>صفحة ${b.page}</strong> — <span>سورة ${esc(b.surahName)}</span>
            <div class="subtitle">بتاريخ: ${b.createdAt}</div>
          </div>
          <div class="surah-card-actions">
            <button class="btn btn-primary btn-sm" data-goto-bm-page="${b.page}" type="button"><span>فتح</span></button>
            <button class="btn btn-danger btn-sm" data-del-bm-page="${i}" type="button"><span>حذف</span></button>
          </div>
        </div>
      `).join('');

      pagesEl.querySelectorAll('[data-goto-bm-page]').forEach(btn => {
        btn.addEventListener('click', () => {
          this.switchView('mushaf');
          this.mushaf.loadPage(parseInt(btn.dataset.gotoBmPage, 10));
        });
      });
      pagesEl.querySelectorAll('[data-del-bm-page]').forEach(btn => {
        btn.addEventListener('click', () => {
          const list = this.storage.getSettings().pageBookmarks;
          list.splice(parseInt(btn.dataset.delBmPage, 10), 1);
          this.storage.saveSettings({ pageBookmarks: list });
          this.renderBookmarksView();
        });
      });
    }

    if (!s.favoriteVerses || s.favoriteVerses.length === 0) {
      favsEl.innerHTML = '<p class="empty-state">لا توجد آيات في المفضلة بعد.</p>';
    } else {
      favsEl.innerHTML = s.favoriteVerses.map((f, i) => `
        <div class="bookmark-item">
          <div style="flex:1;">
            <strong>الآية ${f.verseKey}</strong>
            <div class="result-arabic">${esc(f.arabicText)}</div>
            ${f.note ? `<div class="notice-bar">ملاحظتي: ${esc(f.note)}</div>` : ''}
          </div>
          <div class="surah-card-actions">
            <button class="btn btn-primary btn-sm" data-goto-fav="${f.verseKey}" type="button"><span>المصحف</span></button>
            <button class="btn btn-outline btn-sm" data-note-fav="${i}" type="button"><span>ملاحظة</span></button>
            <button class="btn btn-danger btn-sm" data-del-fav="${i}" type="button"><span>حذف</span></button>
          </div>
        </div>
      `).join('');

      favsEl.querySelectorAll('[data-goto-fav]').forEach(btn => {
        btn.addEventListener('click', () => this.jumpToVerseInMushaf(btn.dataset.gotoFav));
      });
      favsEl.querySelectorAll('[data-note-fav]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.noteFav, 10);
          const list = this.storage.getSettings().favoriteVerses;
          const currentNote = list[idx].note || '';
          const modal = document.getElementById('app-modal');
          document.getElementById('modal-title').textContent = `ملاحظة شخصية للآية ${list[idx].verseKey}`;
          document.getElementById('modal-body').innerHTML = `
            <textarea id="fav-note-textarea" class="input" style="width:100%;min-height:110px;">${esc(currentNote)}</textarea>
            <div style="margin-top:12px;">
              <button id="btn-save-fav-note" class="btn btn-primary" type="button"><span>حفظ الملاحظة</span></button>
            </div>
          `;
          modal.classList.remove('hidden');
          document.getElementById('btn-save-fav-note').addEventListener('click', () => {
            list[idx].note = document.getElementById('fav-note-textarea').value.trim();
            this.storage.saveSettings({ favoriteVerses: list });
            modal.classList.add('hidden');
            this.renderBookmarksView();
            this.showToast('تم حفظ الملاحظة.');
          });
        });
      });
      favsEl.querySelectorAll('[data-del-fav]').forEach(btn => {
        btn.addEventListener('click', () => {
          const list = this.storage.getSettings().favoriteVerses;
          list.splice(parseInt(btn.dataset.delFav, 10), 1);
          this.storage.saveSettings({ favoriteVerses: list });
          this.renderBookmarksView();
        });
      });
    }
  }

  async jumpToVerseInMushaf(verseKey) {
    this.switchView('mushaf');
    const page = await this.mushaf.findVerseKeyPage(verseKey);
    await this.mushaf.loadPage(page, verseKey);
  }

  injectExtras() {
    // تصدير/استيراد العلامات والمفضلة (localStorage قد يُمسح)
    const bm = document.getElementById('view-bookmarks');
    const box = document.createElement('div');
    box.className = 'surah-card-actions';
    box.style.margin = '12px 0';
    box.innerHTML = `
      <button id="btn-export-data" class="btn btn-outline btn-sm" type="button"><span>تصدير العلامات والمفضلة</span></button>
      <button id="btn-import-data" class="btn btn-outline btn-sm" type="button"><span>استيراد من ملف</span></button>
      <input id="import-data-file" type="file" accept="application/json,.json" hidden />`;
    bm.appendChild(box);
    document.getElementById('btn-export-data').addEventListener('click', () => this.exportUserData());
    document.getElementById('btn-import-data').addEventListener('click', () => document.getElementById('import-data-file').click());
    document.getElementById('import-data-file').addEventListener('change', (e) => this.importUserData(e.target.files[0]));

    // عن التطبيق: الرواية والمصادر
    const st = document.getElementById('view-settings');
    const about = document.createElement('div');
    about.className = 'notice-bar';
    about.style.marginTop = '16px';
    about.innerHTML = `<strong>عن التطبيق</strong><br>
      الرواية: حفص عن عاصم. نص الآيات وأرقام الصفحات والتلاوات والتفاسير من واجهة Quran.com API v4 (Quran Foundation).
      التفاسير: الميسر، ابن كثير، الطبري، السعدي. يُعرض النص متصلًا بخط Amiri Quran وليس بتقسيم الـ 15 سطرًا،
      وللتحقق من أي آية يُرجى الرجوع إلى مصحف مطبوع معتمد.`;
    st.appendChild(about);

    document.addEventListener('visibilitychange', () => this.updateWakeLock());

    // الورد اليومي والختمة
    const grid = document.querySelector('#view-home .dashboard-grid');
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h3>الورد اليومي والختمة</h3>
      <p id="wird-text"></p>
      <progress id="wird-bar" max="100" value="0" style="width:100%"></progress>
      <p id="khatma-text"></p>
      <progress id="khatma-bar" max="100" value="0" style="width:100%"></progress>
      <div class="surah-card-actions" style="margin-top:10px;">
        <label for="wird-target">هدفي اليومي (صفحات):</label>
        <input id="wird-target" type="number" min="1" max="60" class="input input-xs" />
        <button id="btn-reset-khatma" class="btn btn-outline btn-sm" type="button"><span>بدء ختمة جديدة</span></button>
      </div>
      <p class="subtitle">تُحتسب الصفحة بعد بقائها مفتوحة 15 ثانية. (20 صفحة = جزء)</p>`;
    if (grid) grid.appendChild(card);
    document.getElementById('wird-target').addEventListener('change', (e) => {
      this.progress.setTarget(e.target.value);
      this.renderProgress();
    });
    document.getElementById('btn-reset-khatma').addEventListener('click', () => {
      if (confirm('سيتم تصفير تقدم الختمة الحالية. هل تريد المتابعة؟')) {
        this.progress.resetKhatma();
        this.renderProgress();
      }
    });
    this.renderProgress();

    // تنزيل مجموعة سور مرة واحدة
    const dv = document.getElementById('view-downloads');
    const groups = {
      amma: { label: 'جزء عمّ (78–114)', ids: Array.from({ length: 37 }, (_, i) => 78 + i) },
      salah: { label: 'سور قصيرة للصلاة (الفاتحة و105–114)', ids: [1, ...Array.from({ length: 10 }, (_, i) => 105 + i)] },
      masnun: { label: 'الكهف والسجدة ويس والملك', ids: [18, 32, 36, 67] }
    };
    const batch = document.createElement('div');
    batch.className = 'card';
    batch.innerHTML = `
      <h3>تنزيل مجموعة سور</h3>
      <div class="surah-card-actions">
        <select id="batch-group-select" class="select select-sm">
          ${Object.entries(groups).map(([k, g]) => `<option value="${k}">${g.label}</option>`).join('')}
        </select>
        <button id="btn-batch-download" class="btn btn-primary btn-sm" type="button"><span>تنزيل المجموعة</span></button>
      </div>
      <p class="subtitle">يُنزَّل بالقارئ الحالي، وتُتخطى السور المنزّلة مسبقًا. المساحة قد تكون كبيرة، فتأكد من اتصال Wi-Fi.</p>`;
    dv.insertBefore(batch, dv.children[1] || null);
    document.getElementById('btn-batch-download').addEventListener('click', (e) => {
      const key = document.getElementById('batch-group-select').value;
      this.downloadBatch(groups[key].ids, e.currentTarget);
    });
  }

  onPageRead(page) {
    if (document.hidden || !document.getElementById('view-mushaf')?.classList.contains('active')) return;
    const r = this.progress.markPage(page);
    this.renderProgress();
    if (r.completedNow) this.showToast('ما شاء الله! أتممت ختمة كاملة. تقبّل الله منك.');
    else if (r.added && r.todayCount === r.target) this.showToast('أتممت وردك اليومي. بارك الله فيك.');
  }

  renderProgress() {
    const s = this.progress.summary();
    const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
    set('wird-text', el => el.textContent = `اليوم: ${s.todayCount} / ${s.target} صفحة — أيام متتالية: ${s.streak}`);
    set('wird-bar', el => el.value = Math.min(100, Math.round((s.todayCount / s.target) * 100)));
    set('khatma-text', el => el.textContent = `الختمة الحالية: ${s.khatmaRead} / 604 صفحة (${s.khatmaPct}%) — ختمات مكتملة: ${s.completed}`);
    set('khatma-bar', el => el.value = s.khatmaPct);
    set('wird-target', el => { if (document.activeElement !== el) el.value = s.target; });
  }

  async downloadBatch(ids, btn) {
    navigator.storage?.persist?.().catch(() => {});
    const recId = this.storage.getSettings().reciterId || 7;
    const todo = ids.filter(id => !this.downloadedSurahIds?.has(id));
    if (!todo.length) { this.showToast('كل سور هذه المجموعة منزّلة بالفعل.'); return; }
    btn.disabled = true;
    let done = 0;
    try {
      for (const id of todo) {
        await this.player.downloadSurahForOffline(id, recId, (pct) => {
          btn.querySelector('span').textContent = `(${done + 1}/${todo.length}) ${pct}%`;
        });
        done++;
      }
      this.showToast(`اكتمل تنزيل ${done} سورة.`);
    } catch (err) {
      this.showToast(`توقف التنزيل بعد ${done} من ${todo.length} سورة. ${err?.message?.includes('CORS') ? err.message : 'تحقق من الاتصال ثم أعد المحاولة.'}`);
    }
    btn.disabled = false;
    btn.querySelector('span').textContent = 'تنزيل المجموعة';
    await this.refreshDownloadsView();
  }

  exportUserData() {
    const s = this.storage.getSettings();
    const payload = {
      app: 'moshafi', version: 1, exportedAt: new Date().toISOString(),
      pageBookmarks: s.pageBookmarks || [], favoriteVerses: s.favoriteVerses || [],
      lastReading: s.lastReading, lastListening: s.lastListening
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `moshafi-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async importUserData(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.app !== 'moshafi') throw new Error('bad file');
      const s = this.storage.getSettings();
      const pages = [...(s.pageBookmarks || [])];
      for (const b of Array.isArray(data.pageBookmarks) ? data.pageBookmarks : []) {
        const page = Number(b?.page);
        if (page >= 1 && page <= 604 && !pages.some(x => x.page === page)) {
          pages.push({ page, surahName: String(b.surahName || ''), createdAt: String(b.createdAt || '') });
        }
      }
      const favs = [...(s.favoriteVerses || [])];
      for (const f of Array.isArray(data.favoriteVerses) ? data.favoriteVerses : []) {
        const key = String(f?.verseKey || '');
        if (/^\d{1,3}:\d{1,3}$/.test(key) && !favs.some(x => x.verseKey === key)) {
          favs.push({ verseKey: key, arabicText: String(f.arabicText || ''), note: String(f.note || ''), createdAt: String(f.createdAt || '') });
        }
      }
      this.storage.saveSettings({ pageBookmarks: pages, favoriteVerses: favs });
      this.renderBookmarksView();
      this.showToast('تم استيراد العلامات والمفضلة.');
    } catch {
      this.showToast('الملف غير صالح.');
    }
    document.getElementById('import-data-file').value = '';
  }

  handleSearchResultClick(item) {
    if (item.page) {
      this.switchView('mushaf');
      this.mushaf.loadPage(item.page, item.verseKey);
    } else if (item.verseKey) {
      this.jumpToVerseInMushaf(item.verseKey);
    }
  }

  bindGlobalEvents() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });
    document.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.goto));
    });

    document.getElementById('home-surah-filter').addEventListener('input', (e) => {
      this.renderHomeSurahs(e.target.value.trim());
    });

    document.getElementById('btn-resume-reading').addEventListener('click', () => {
      const s = this.storage.getSettings();
      this.switchView('mushaf');
      this.mushaf.loadPage(s.lastReading?.page || 1, `${s.lastReading?.surah || 1}:${s.lastReading?.ayah || 1}`);
    });

    document.getElementById('btn-resume-listening').addEventListener('click', () => {
      const s = this.storage.getSettings();
      const l = s.lastListening || {};
      this.player.loadAndPlaySurah(l.surah || 1, l.ayah || 1, l.reciterId || s.reciterId || 7, l.time || null);
    });

    document.getElementById('btn-download-current-surah').addEventListener('click', (e) => {
      this.triggerSurahDownload(this.mushaf.currentSurah, e.currentTarget);
    });

    document.getElementById('btn-clear-all-downloads').addEventListener('click', async () => {
      await this.storage.clearAllOfflineData();
      this.showToast('تم حذف جميع التنزيلات.');
      await this.refreshDownloadsView();
    });

    // Font Size & Theme & Simple Mode Controls
    document.getElementById('btn-font-inc').addEventListener('click', () => {
      const cur = this.storage.getSettings().quranFontSize;
      if (cur < 48) {
        this.storage.saveSettings({ quranFontSize: cur + 2 });
        this.applySettingsToUI();
      }
    });
    document.getElementById('btn-font-dec').addEventListener('click', () => {
      const cur = this.storage.getSettings().quranFontSize;
      if (cur > 20) {
        this.storage.saveSettings({ quranFontSize: cur - 2 });
        this.applySettingsToUI();
      }
    });

    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
      const next = this.storage.getSettings().theme === 'dark' ? 'light' : 'dark';
      this.storage.saveSettings({ theme: next });
      this.applySettingsToUI();
    });

    document.getElementById('btn-simple-mode').addEventListener('click', () => {
      const next = !this.storage.getSettings().simpleMode;
      this.storage.saveSettings({ simpleMode: next });
      this.applySettingsToUI();
    });

    // Settings view inputs
    document.getElementById('setting-theme').addEventListener('change', (e) => {
      this.storage.saveSettings({ theme: e.target.value });
      this.applySettingsToUI();
    });
    document.getElementById('setting-quran-font-size').addEventListener('input', (e) => {
      this.storage.saveSettings({ quranFontSize: parseInt(e.target.value, 10) });
      this.applySettingsToUI();
    });
    document.getElementById('setting-ui-font-size').addEventListener('input', (e) => {
      this.storage.saveSettings({ uiFontSize: parseInt(e.target.value, 10) });
      this.applySettingsToUI();
    });
    document.getElementById('setting-mushaf-mode').addEventListener('change', (e) => {
      this.storage.saveSettings({ mushafMode: e.target.value });
      this.mushaf.setMode(e.target.value);
    });
    document.getElementById('setting-reciter').addEventListener('change', (e) => {
      const recId = parseInt(e.target.value, 10);
      this.storage.saveSettings({ reciterId: recId });
      document.getElementById('listen-reciter-select').value = recId;
      this.player.currentReciterId = recId;
      this.player.updateHeaderDisplay();
    });
    document.getElementById('listen-reciter-select').addEventListener('change', (e) => {
      const recId = parseInt(e.target.value, 10);
      this.storage.saveSettings({ reciterId: recId });
      document.getElementById('setting-reciter').value = recId;
      this.player.currentReciterId = recId;
      this.player.updateHeaderDisplay();
    });
    document.getElementById('setting-tafsir').addEventListener('change', (e) => {
      const tId = parseInt(e.target.value, 10);
      this.storage.saveSettings({ tafsirId: tId });
      document.getElementById('tafsir-source-select').value = tId;
    });
    document.getElementById('setting-playback-rate').addEventListener('change', (e) => {
      const r = parseFloat(e.target.value);
      this.storage.saveSettings({ playbackRate: r });
      this.player.audio.playbackRate = r;
      document.getElementById('player-speed').value = r;
    });
    document.getElementById('setting-simple-mode').addEventListener('change', (e) => {
      this.storage.saveSettings({ simpleMode: e.target.checked });
      this.applySettingsToUI();
    });

    document.getElementById('btn-close-modal').addEventListener('click', () => {
      document.getElementById('app-modal').classList.add('hidden');
    });
  }

  showToast(message) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new MoshafiApp();
  app.init();
});
