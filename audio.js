import { API_BASE } from './config.js';
import { fetchChapterVerses, getPageVerses } from './quran-api.js';

export const VERIFIED_RECITERS = [
  { id: 7, name: 'مشاري راشد العفاسي', style: 'مرتل' },
  { id: 2, name: 'عبد الباسط عبد الصمد', style: 'مرتل' },
  { id: 3, name: 'عبد الرحمن السديس', style: 'مرتل' },
  { id: 4, name: 'أبو بكر الشاطري', style: 'مرتل' },
  { id: 5, name: 'هاني الرفاعي', style: 'مرتل' },
  { id: 6, name: 'محمود خليل الحصري', style: 'مرتل' },
  { id: 10, name: 'سعود الشريم', style: 'مرتل' }
];

export class AudioPlayerManager {
  constructor(storage, tafsirManager, wordSync, onVerseChange, onJumpToMushaf, onNotify) {
    this.storage = storage;
    this.tafsirManager = tafsirManager;
    this.wordSync = wordSync;
    this.onVerseChange = onVerseChange;
    this.onJumpToMushaf = onJumpToMushaf;
    this.onNotify = onNotify;

    this.audio = document.getElementById('quran-audio-element');
    this.chapters = [];
    this.currentSurah = 1;
    this.currentReciterId = 7;
    this.currentVerseKey = '1:1';
    this.versesData = [];
    this.syncTimer = null;
    this.sleepTimeout = null;
    this.sleepInterval = null;
    this.lastTafsirFetchedVerse = null;
    this.currentObjectUrl = null;
    this.loadToken = 0;
    this.tafsirReq = 0;
    this.lastSaveAt = 0;
    this._lastRenderKey = null;
    this.repeatDone = 0;
    this.stopAtSurahEnd = false;
    this.loadingAudio = false;
  }

  init(chapters) {
    this.chapters = chapters;
    const settings = this.storage.getSettings();
    this.currentReciterId = settings.reciterId || 7;
    this.currentSurah = settings.lastListening?.surah || 1;
    this.currentVerseKey = `${this.currentSurah}:${settings.lastListening?.ayah || 1}`;
    this.audio.playbackRate = settings.playbackRate || 1;

    this.bindControls();
    this.setupMediaSession();
    this.updateHeaderDisplay();
  }

  bindControls() {
    document.getElementById('btn-play-pause').addEventListener('click', () => this.togglePlay());
    document.getElementById('btn-prev-ayah').addEventListener('click', () => this.stepAyah(-1));
    document.getElementById('btn-next-ayah').addEventListener('click', () => this.stepAyah(1));
    document.getElementById('btn-prev-surah').addEventListener('click', () => {
      if (this.currentSurah > 1) this.loadAndPlaySurah(this.currentSurah - 1, 1);
    });
    document.getElementById('btn-next-surah').addEventListener('click', () => {
      if (this.currentSurah < 114) this.loadAndPlaySurah(this.currentSurah + 1, 1);
    });

    document.getElementById('btn-seek-back').addEventListener('click', () => {
      this.audio.currentTime = Math.max(0, this.audio.currentTime - 10);
    });
    document.getElementById('btn-seek-forward').addEventListener('click', () => {
      const dur = Number.isFinite(this.audio.duration) ? this.audio.duration : Infinity;
      this.audio.currentTime = Math.min(dur, this.audio.currentTime + 10);
    });

    const seekBar = document.getElementById('player-seek-bar');
    seekBar.addEventListener('input', () => {
      if (this.audio.duration) {
        this.audio.currentTime = (parseFloat(seekBar.value) / 100) * this.audio.duration;
      }
    });

    document.getElementById('player-speed').addEventListener('change', (e) => {
      const rate = parseFloat(e.target.value);
      this.audio.playbackRate = rate;
      this.storage.saveSettings({ playbackRate: rate });
    });

    document.getElementById('player-repeat-mode').addEventListener('change', (e) => {
      document.getElementById('repeat-range-inputs').classList.toggle('hidden', e.target.value !== 'range');
      document.getElementById('repeat-count-wrap').classList.toggle('hidden', !['ayah', 'range'].includes(e.target.value));
      this.repeatDone = 0;
    });

    document.getElementById('player-sleep-timer').addEventListener('change', (e) => {
      this.setSleepTimer(parseInt(e.target.value, 10));
    });

    // أزرار الاختيار (بدل القوائم المنسدلة): تضبط القيمة وتُشغّل نفس الحدث
    document.querySelectorAll('.chip-group').forEach(group => {
      group.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        const sel = document.getElementById(group.dataset.select);
        sel.value = chip.dataset.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        this.syncOptionChips();
      });
    });
    this.syncOptionChips();

    // المشغل: شريط مصغّر ↔ نافذة كاملة
    document.getElementById('player-mini-main').addEventListener('click', () => this.openSheet());
    document.getElementById('btn-player-collapse').addEventListener('click', () => this.closeSheet());
    document.getElementById('player-backdrop').addEventListener('click', () => this.closeSheet());
    document.getElementById('btn-mini-play').addEventListener('click', () => this.togglePlay());
    document.getElementById('btn-player-close').addEventListener('click', () => this.closePlayer());

    document.getElementById('btn-jump-to-ayah-mushaf').addEventListener('click', () => {
      if (this.onJumpToMushaf) this.onJumpToMushaf(this.currentVerseKey);
    });
    document.getElementById('btn-expand-live-tafsir').addEventListener('click', () => {
      const modal = document.getElementById('app-modal');
      document.getElementById('modal-title').textContent = document.getElementById('live-tafsir-title').textContent;
      const body = document.getElementById('modal-body');
      body.textContent = '';
      const p = document.createElement('p');
      p.style.cssText = 'line-height:1.9;font-size:1.1rem;';
      p.textContent = document.getElementById('live-tafsir-content').textContent;
      body.appendChild(p);
      modal.classList.remove('hidden');
    });

    // Audio element events
    this.audio.addEventListener('play', () => {
      this.setPlayingUI(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      this.startSyncLoop();
    });

    this.audio.addEventListener('pause', () => {
      this.setPlayingUI(false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      this.stopSyncLoop();
      this.saveListening();
    });

    this.audio.addEventListener('ended', () => {
      if (this.stopAtSurahEnd) {
        this.setSleepTimer(0);
        document.getElementById('player-sleep-timer').value = '0'; this.syncOptionChips?.();
        this.onNotify('انتهت السورة وتم الإيقاف حسب المؤقت.');
        return;
      }
      const repeatMode = document.getElementById('player-repeat-mode').value;
      if (repeatMode === 'surah') {
        this.audio.currentTime = 0;
        this.audio.play();
      } else if (this.currentSurah < 114) {
        this.loadAndPlaySurah(this.currentSurah + 1, 1);
      }
    });

    // timeupdate يستمر والشاشة مقفولة (على عكس requestAnimationFrame)
    this.audio.addEventListener('timeupdate', () => {
      this.updateProgressUI();
      this.tick();
    });
    this.audio.addEventListener('error', () => {
      if (this.audio.src && !this.loadingAudio) this.onNotify('حدث خطأ في تشغيل الصوت. تحقق من الاتصال أو نزّل السورة.');
    });
  }

  updateHeaderDisplay() {
    const ch = this.chapters.find(c => c.id === this.currentSurah);
    const rec = VERIFIED_RECITERS.find(r => r.id === this.currentReciterId);
    document.getElementById('player-surah-title').textContent = ch ? `سورة ${ch.name_arabic}` : `سورة ${this.currentSurah}`;
    document.getElementById('player-reciter-name').textContent = rec ? rec.name : 'قارئ معتمد';
    document.getElementById('player-verse-badge').textContent = `الآية ${this.currentVerseKey}`;
    document.getElementById('player-mini-title').textContent = ch ? `سورة ${ch.name_arabic}` : `سورة ${this.currentSurah}`;
    document.getElementById('player-mini-sub').textContent =
      `${rec ? rec.name : 'قارئ معتمد'} · آية ${this.currentVerseKey.split(':')[1] || 1}`;
  }

  // ===== واجهة المشغل (شريط مصغّر + نافذة كاملة) =====
  setPlayingUI(isPlaying) {
    document.getElementById('persistent-player').classList.toggle('is-playing', isPlaying);
  }

  syncOptionChips() {
    document.querySelectorAll('.chip-group').forEach(group => {
      const val = document.getElementById(group.dataset.select)?.value;
      group.querySelectorAll('.chip').forEach(c => {
        const on = String(c.dataset.value) === String(val);
        c.classList.toggle('active', on);
        c.setAttribute('aria-pressed', String(on));
      });
    });
  }

  showPlayer() {
    document.getElementById('persistent-player').classList.add('has-track');
    document.body.classList.add('has-player');
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  openSheet() {
    document.getElementById('persistent-player').classList.add('sheet-open');
    document.body.classList.add('sheet-open');
  }

  closeSheet() {
    document.getElementById('persistent-player').classList.remove('sheet-open');
    document.body.classList.remove('sheet-open');
  }

  closePlayer() {
    this.audio.pause();
    this.closeSheet();
    document.getElementById('persistent-player').classList.remove('has-track');
    document.body.classList.remove('has-player');
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  async loadAndPlaySurah(surahId, startAyah = 1, reciterId = null, startTime = null) {
    const token = ++this.loadToken; // الضغطة الأحدث فقط هي التي تكمل
    if (reciterId) {
      this.currentReciterId = reciterId;
      this.storage.saveSettings({ reciterId });
    }
    this.currentSurah = surahId;
    this.currentVerseKey = `${surahId}:${startAyah}`;
    this.lastTafsirFetchedVerse = null;
    this._lastRenderKey = null;
    document.getElementById('word-sync-text').dataset.renderedVerse = '';
    this.updateHeaderDisplay();

    this.showPlayer();

    const pkgKey = `${this.currentReciterId}_${surahId}`;
    const offlinePkg = await this.storage.getRecord('surah_packages', pkgKey);
    if (token !== this.loadToken) return;

    let audioSrc = null, verses = null, audioFileMeta = null, isOfflinePlayback = false;

    if (offlinePkg) {
      const localBlobUrl = await this.storage.getOfflineAudioUrl(offlinePkg.audioUrl);
      if (token !== this.loadToken) { if (localBlobUrl) URL.revokeObjectURL(localBlobUrl); return; }
      if (localBlobUrl) {
        if (this.currentObjectUrl) URL.revokeObjectURL(this.currentObjectUrl);
        this.currentObjectUrl = localBlobUrl;
        audioSrc = localBlobUrl;
        verses = offlinePkg.verses;
        audioFileMeta = offlinePkg.audioFileMeta;
        isOfflinePlayback = true;
      }
    }

    if (!audioSrc) {
      try {
        const [audioRes, chapterVerses] = await Promise.all([
          fetch(`${API_BASE}/chapter_recitations/${this.currentReciterId}/${surahId}?segments=true`),
          fetchChapterVerses(surahId)
        ]);
        if (!audioRes.ok) throw new Error('فشل الاتصال بمصدر التلاوة');
        const audioJson = await audioRes.json();
        audioFileMeta = audioJson.audio_file;
        audioSrc = audioFileMeta?.audio_url;
        verses = chapterVerses;
        if (!audioSrc) throw new Error('لا يوجد ملف صوتي');
      } catch {
        if (token === this.loadToken) this.onNotify('تعذر تشغيل السورة. تأكد من الاتصال بالإنترنت أو قم بتنزيل السورة للاستماع بدون إنترنت.');
        return;
      }
      if (token !== this.loadToken) return;
    }

    this.versesData = verses;
    this.wordSync.loadChapterData(verses, audioFileMeta);
    document.getElementById('player-offline-indicator').classList.toggle('hidden', !isOfflinePlayback);

    // تحميل الصوت مع معالجة الخطأ ومهلة، بدل الانتظار للأبد
    this.loadingAudio = true;
    this.repeatDone = 0;
    try {
      await new Promise((resolve, reject) => {
        const a = this.audio;
        const cleanup = () => {
          clearTimeout(timer);
          a.removeEventListener('loadedmetadata', ok);
          a.removeEventListener('error', fail);
        };
        const ok = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error('audio load failed')); };
        const timer = setTimeout(fail, 25000);
        a.addEventListener('loadedmetadata', ok);
        a.addEventListener('error', fail);
        a.src = audioSrc;
        a.playbackRate = this.storage.getSettings().playbackRate || 1;
      });
    } catch {
      if (token === this.loadToken) this.onNotify('تعذر تحميل الملف الصوتي. تحقق من الاتصال ثم أعد المحاولة.');
      return;
    } finally {
      if (token === this.loadToken) this.loadingAudio = false;
    }
    if (token !== this.loadToken) return;

    // لا توجد توقيتات من المصدر → توزيع تقريبي حتى يعمل تمييز الآية والتكرار
    let syncMode = this.wordSync.hasRealWordTimings ? 'words' : (this.wordSync.verseTimings.size ? 'verses' : 'none');
    if (syncMode === 'none' && Number.isFinite(this.audio.duration)) {
      if (this.wordSync.buildEstimatedTimings(this.audio.duration * 1000)) syncMode = 'estimated';
    }
    document.getElementById('sync-availability-notice').textContent = {
      words: 'تتوفر توقيتات كلمات دقيقة لهذا القارئ والتسجيل.',
      verses: 'يتوفر توقيت كل آية لهذا التسجيل دون توقيت الكلمات؛ يُميَّز مقطع الآية الحالية.',
      estimated: 'هذا التسجيل لا يوفر توقيتات؛ تمييز الآية والتكرار تقريبيان (موزّعان حسب طول الآيات) وقد ينحرفان قليلًا.',
      none: 'لا تتوفر توقيتات لهذا التسجيل، لذلك لن يتم تمييز الآيات تلقائيًا.'
    }[syncMode];

    if (startTime !== null && Number.isFinite(startTime) && startTime > 0) {
      this.audio.currentTime = startTime;
    } else {
      const targetStartMs = this.wordSync.getVerseStartMs(`${surahId}:${startAyah}`);
      if (targetStartMs !== null && startAyah > 1) this.audio.currentTime = targetStartMs / 1000;
    }

    this.renderVerseForSync(`${surahId}:${startAyah}`, null);
    this.updateLiveTafsir(`${surahId}:${startAyah}`);
    this.updateMediaMetadata();

    try {
      await this.audio.play();
    } catch {
      this.onNotify('اضغط على زر تشغيل لبدء الصوت.');
    }
  }

  // ---- Media Session: تحكم من شاشة القفل والإشعارات ----
  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
    set('play', () => this.audio.play());
    set('pause', () => this.audio.pause());
    set('previoustrack', () => this.stepAyah(-1));
    set('nexttrack', () => this.stepAyah(1));
    set('seekbackward', () => { this.audio.currentTime = Math.max(0, this.audio.currentTime - 10); });
    set('seekforward', () => {
      const dur = Number.isFinite(this.audio.duration) ? this.audio.duration : Infinity;
      this.audio.currentTime = Math.min(dur, this.audio.currentTime + 10);
    });
    set('seekto', (d) => { if (d.seekTime != null) this.audio.currentTime = d.seekTime; });
  }

  updateMediaMetadata() {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const ch = this.chapters.find(c => c.id === this.currentSurah);
    const rec = VERIFIED_RECITERS.find(r => r.id === this.currentReciterId);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ch ? `سورة ${ch.name_arabic}` : `سورة ${this.currentSurah}`,
      artist: rec ? rec.name : 'قارئ',
      album: 'مصحفي',
      artwork: [{ src: './icon-512.png', sizes: '512x512', type: 'image/png' }]
    });
  }

  updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = this.audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({ duration: d, playbackRate: this.audio.playbackRate || 1, position: Math.min(this.audio.currentTime, d) });
    } catch {}
  }

  saveListening() {
    const ayahNum = parseInt(this.currentVerseKey.split(':')[1], 10) || 1;
    this.lastSaveAt = Date.now();
    this.storage.saveSettings({
      lastListening: { surah: this.currentSurah, ayah: ayahNum, reciterId: this.currentReciterId, time: this.audio.currentTime || 0 }
    });
  }

  togglePlay() {
    if (!this.audio.src) {
      const ls = this.storage.getSettings().lastListening || {};
      const ayah = parseInt(this.currentVerseKey.split(':')[1], 10) || 1;
      const sameSpot = ls.surah === this.currentSurah && ls.ayah === ayah;
      this.loadAndPlaySurah(this.currentSurah, ayah, null, sameSpot ? ls.time : null);
      return;
    }
    if (this.audio.paused) {
      this.audio.play();
    } else {
      this.audio.pause();
    }
  }

  stepAyah(delta) {
    const parts = this.currentVerseKey.split(':');
    const surah = parseInt(parts[0], 10);
    const ayah = parseInt(parts[1], 10);
    const targetAyah = ayah + delta;
    if (targetAyah < 1) return;
    const targetKey = `${surah}:${targetAyah}`;
    const startMs = this.wordSync.getVerseStartMs(targetKey);
    if (startMs !== null) {
      this.audio.currentTime = startMs / 1000;
      this.currentVerseKey = targetKey;
      this.updateHeaderDisplay();
      this.renderVerseForSync(targetKey, null);
      this.updateLiveTafsir(targetKey);
    }
  }

  startSyncLoop() {
    this.stopSyncLoop();
    // مؤقت 100ms لتظليل الكلمات بسلاسة؛ timeupdate يغطي حالة الخلفية/قفل الشاشة
    this.syncTimer = setInterval(() => { if (!document.hidden) this.tick(); }, 100);
  }

  stopSyncLoop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  tick() {
    const currentMs = this.audio.currentTime * 1000;
    const state = this.wordSync.getActiveStateAtMs(currentMs);
    if (!state) return;

    if (!this.audio.paused) {
      const repeatMode = document.getElementById('player-repeat-mode').value;
      // هامش 250ms لأن timeupdate يصل كل ~250ms
      const maxRepeats = parseInt(document.getElementById('repeat-count').value, 10) || 0; // 0 = بلا حد
      const canRepeat = !maxRepeats || this.repeatDone < maxRepeats - 1;
      if (repeatMode === 'ayah' && currentMs >= state.verseEndMs - 250) {
        if (canRepeat) {
          this.repeatDone++;
          this.audio.currentTime = state.verseStartMs / 1000;
          return;
        }
      } else if (repeatMode === 'range') {
        const fromAyah = parseInt(document.getElementById('repeat-from').value, 10) || 1;
        const toAyah = parseInt(document.getElementById('repeat-to').value, 10) || 7;
        const currentAyahNum = parseInt(state.verseKey.split(':')[1], 10);
        if (canRepeat && (currentAyahNum > toAyah || (currentAyahNum === toAyah && currentMs >= state.verseEndMs - 250))) {
          const startRangeMs = this.wordSync.getVerseStartMs(`${this.currentSurah}:${fromAyah}`);
          if (startRangeMs !== null) { this.repeatDone++; this.audio.currentTime = startRangeMs / 1000; return; }
        }
      }
    }

    if (state.verseKey !== this.currentVerseKey) {
      if (document.getElementById('player-repeat-mode').value === 'ayah') this.repeatDone = 0;
      this.currentVerseKey = state.verseKey;
      this.updateHeaderDisplay();
      this.updateLiveTafsir(state.verseKey);
      if (this.onVerseChange) this.onVerseChange(state.verseKey);
      this.saveListening();
    } else if (Date.now() - this.lastSaveAt > 5000) {
      this.saveListening();
    }

    this.renderVerseForSync(state.verseKey, state.wordPosition);
    this.updatePositionState();
  }

  renderVerseForSync(verseKey, activeWordPos) {
    const container = document.getElementById('word-sync-text');
    const statusEl = document.getElementById('word-sync-status');
    const words = this.wordSync.versesWords.get(verseKey);
    const renderKey = `${verseKey}|${activeWordPos}`;
    if (renderKey === this._lastRenderKey) return;
    this._lastRenderKey = renderKey;

    if (!words || words.length === 0) {
      const vObj = this.versesData.find(v => v.verse_key === verseKey);
      container.textContent = vObj ? vObj.text_uthmani : '';
      return;
    }

    // Re-render words only if verse changed, otherwise just toggle active class for 60fps smoothness
    if (container.dataset.renderedVerse !== verseKey) {
      container.dataset.renderedVerse = verseKey;
      container.innerHTML = words.map(w =>
        `<span class="sync-word" data-pos="${w.position}" title="اضغط للانتقال إلى هذه الكلمة">${w.text_uthmani}</span>`
      ).join(' ');

      container.querySelectorAll('.sync-word').forEach(el => {
        el.addEventListener('click', () => {
          const pos = parseInt(el.dataset.pos, 10);
          const wStartMs = this.wordSync.getWordStartMs(verseKey, pos);
          if (wStartMs !== null) {
            this.audio.currentTime = wStartMs / 1000;
            if (this.audio.paused) this.audio.play();
          }
        });
      });
    }

    container.querySelectorAll('.sync-word').forEach(el => {
      const pos = parseInt(el.dataset.pos, 10);
      el.classList.toggle('current-word', activeWordPos !== null && pos === activeWordPos);
    });

    statusEl.textContent = this.wordSync.hasRealWordTimings
      ? `الآية ${verseKey} — مزامنة الكلمات نشطة (اضغط على أي كلمة لتشغيلها)`
      : (this.wordSync.estimated ? `الآية ${verseKey} — تمييز تقريبي للآية` : `الآية ${verseKey} — تمييز الآية نشط`);
  }

  async updateLiveTafsir(verseKey) {
    if (this.lastTafsirFetchedVerse === verseKey) return;
    this.lastTafsirFetchedVerse = verseKey;
    const req = ++this.tafsirReq;

    const tafsirId = this.storage.getSettings().tafsirId || 16;
    document.getElementById('live-tafsir-title').textContent = `تفسير الآية الحالية (${verseKey})`;
    this.tafsirManager.prefetchSurah(parseInt(verseKey.split(':')[0], 10), tafsirId);

    const res = await this.tafsirManager.getAyahTafsir(verseKey, tafsirId);
    if (req !== this.tafsirReq) return; // وصل طلب أحدث
    document.getElementById('live-tafsir-source').textContent = res.sourceName;
    document.getElementById('live-tafsir-content').textContent = res.text;
    if (res.error) setTimeout(() => { if (this.lastTafsirFetchedVerse === verseKey) this.lastTafsirFetchedVerse = null; }, 8000);
  }

  updateProgressUI() {
    const cur = this.audio.currentTime || 0;
    const dur = this.audio.duration || 0;
    document.getElementById('player-current-time').textContent = this.formatTime(cur);
    document.getElementById('player-total-time').textContent = this.formatTime(dur);
    if (dur > 0) {
      document.getElementById('player-seek-bar').value = ((cur / dur) * 100).toFixed(2);
    }
  }

  formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  setSleepTimer(minutes) {
    this.stopAtSurahEnd = false;
    if (this.sleepTimeout) clearTimeout(this.sleepTimeout);
    if (this.sleepInterval) clearInterval(this.sleepInterval);
    const badge = document.getElementById('sleep-timer-countdown');

    if (minutes === -1) { // حتى نهاية السورة
      this.stopAtSurahEnd = true;
      badge.classList.remove('hidden');
      badge.textContent = 'حتى نهاية السورة';
      return;
    }

    if (!minutes || minutes <= 0) {
      badge.classList.add('hidden');
      return;
    }

    let remainingSec = minutes * 60;
    badge.classList.remove('hidden');
    badge.textContent = `متبقي ${minutes} د`;

    this.sleepInterval = setInterval(() => {
      remainingSec -= 1;
      if (remainingSec <= 0) {
        clearInterval(this.sleepInterval);
        badge.classList.add('hidden');
      } else {
        badge.textContent = `متبقي ${Math.ceil(remainingSec / 60)} د`;
      }
    }, 1000);

    this.sleepTimeout = setTimeout(() => {
      this.audio.pause();
      document.getElementById('player-sleep-timer').value = '0'; this.syncOptionChips?.();
      badge.classList.add('hidden');
      this.onNotify('تم إيقاف التلاوة تلقائيًا حسب المؤقت المحدد.');
    }, minutes * 60 * 1000);
  }

  // حزمة أوفلاين كاملة: الصوت (بث مباشر للكاش) + الآيات + صفحات المصحف + التوقيتات + التفاسير
  async downloadSurahForOffline(surahId, reciterId, onProgress) {
    const ch = this.chapters.find(c => c.id === surahId);
    const rec = VERIFIED_RECITERS.find(r => r.id === reciterId);

    onProgress(3, 'جلب بيانات السورة...');
    const audioRes = await fetch(`${API_BASE}/chapter_recitations/${reciterId}/${surahId}?segments=true`);
    if (!audioRes.ok) throw new Error('تعذر جلب بيانات التلاوة');
    const audioFileMeta = (await audioRes.json()).audio_file;
    const audioUrl = audioFileMeta?.audio_url;
    if (!audioUrl) throw new Error('لا يوجد ملف صوتي');
    const verses = await fetchChapterVerses(surahId);

    // صفحات المصحف الخاصة بالسورة، حتى تُقرأ بدون إنترنت
    const [fromPage, toPage] = ch ? ch.pages : [1, 1];
    for (let p = fromPage; p <= toPage; p++) {
      await getPageVerses(this.storage, p);
      onProgress(8 + Math.round(((p - fromPage + 1) / (toPage - fromPage + 1)) * 17), 'تنزيل صفحات المصحف...');
    }

    onProgress(26, 'تنزيل التفاسير...');
    await this.tafsirManager.downloadSurahAllTafsirs(surahId);

    onProgress(35, 'تنزيل ملف التلاوة...');
    let response;
    try {
      response = await fetch(audioUrl, { mode: 'cors' });
    } catch {
      throw new Error('خادم الصوت لا يسمح بالتنزيل (CORS)');
    }
    if (!response.ok) throw new Error('فشل تنزيل الملف الصوتي');

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    const headers = new Headers({ 'Content-Type': response.headers.get('content-type') || 'audio/mpeg' });
    if (contentLength) headers.set('Content-Length', String(contentLength));
    let received = 0;

    if (response.body) {
      const reader = response.body.getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          received += value.length;
          if (contentLength > 0) onProgress(35 + Math.round((received / contentLength) * 63), 'جارٍ تنزيل الصوت...');
          controller.enqueue(value);
        },
        cancel(reason) { return reader.cancel(reason); }
      });
      await this.storage.saveAudioResponse(audioUrl, new Response(stream, { headers }));
    } else {
      const blob = await response.blob();
      received = blob.size;
      await this.storage.saveAudioBlob(audioUrl, blob);
    }

    await this.storage.putRecord('surah_packages', {
      key: `${reciterId}_${surahId}`,
      surahId,
      surahName: ch ? ch.name_arabic : `سورة ${surahId}`,
      reciterId,
      reciterName: rec ? rec.name : '',
      audioUrl,
      audioFileMeta,
      verses,
      sizeBytes: received || contentLength,
      downloadedAt: new Date().toLocaleDateString('ar-EG')
    });

    onProgress(100, 'اكتمل التنزيل بنجاح');
  }
}
