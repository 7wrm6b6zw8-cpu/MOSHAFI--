// محرك مزامنة الصوت مع الآيات.
// يتحمّل اختلاف شكل استجابة الـ API (verse_timings / timestamps، ثواني أو ملّي ثانية، مقاطع 0 أو 1-based)،
// ويتحقق أن التوقيتات تطابق طول الملف الصوتي فعلًا قبل الاعتماد عليها.
const ARABIC_LETTERS = /[^\u0621-\u064A]/g;

export class WordSyncEngine {
  constructor() {
    this.verseTimings = new Map(); // verseKey -> { from, to, segments: [[wordPos, startMs, endMs], ...] }
    this.versesWords = new Map();  // verseKey -> [{ position, text_uthmani }]
    this.timeline = [];            // نفس التوقيتات مرتبة زمنيًا للبحث السريع
    this.hasRealWordTimings = false;
    this.estimated = false;
  }

  static num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

  // مقطع الكلمة: آخر ثلاثة أرقام = [موضع الكلمة، بداية، نهاية] (يتحمل صيغة [فهرس، موضع، بداية، نهاية])
  static normSegment(seg) {
    if (!Array.isArray(seg) || seg.length < 3) return null;
    const t = seg.slice(-3).map(WordSyncEngine.num);
    return t.every(x => x !== null) ? t : null;
  }

  loadChapterData(verses, audioFileMeta) {
    this.verseTimings.clear();
    this.versesWords.clear();
    this.timeline = [];
    this.hasRealWordTimings = false;
    this.estimated = false;

    for (const v of (Array.isArray(verses) ? verses : [])) {
      const words = (v.words || []).filter(w => !w.char_type_name || w.char_type_name === 'word');
      this.versesWords.set(v.verse_key, words);
    }

    // الاسم يختلف حسب إصدار الـ API
    const raw = audioFileMeta?.verse_timings || audioFileMeta?.timestamps || audioFileMeta?.verseTimings || [];
    for (const vt of raw) {
      const key = vt.verse_key || vt.verseKey;
      const from = WordSyncEngine.num(vt.timestamp_from ?? vt.timestampFrom ?? vt.from);
      const to = WordSyncEngine.num(vt.timestamp_to ?? vt.timestampTo ?? vt.to);
      if (!key || from === null || to === null) continue;
      let segments = (Array.isArray(vt.segments) ? vt.segments : []).map(WordSyncEngine.normSegment).filter(Boolean);

      if (segments.length) {
        // مقاطع نسبية لبداية الآية بدل أن تكون مطلقة في ملف السورة
        if (segments[0][1] < from - 50) segments = segments.map(([p, s, e]) => [p, s + from, e + from]);
        // مواضع تبدأ من 0 بدل 1
        const words = this.versesWords.get(key) || [];
        const maxPos = Math.max(...segments.map(s => s[0]));
        const minPos = Math.min(...segments.map(s => s[0]));
        if (minPos === 0 && (!words.length || maxPos === words.length - 1)) segments = segments.map(([p, s, e]) => [p + 1, s, e]);
      }
      this.verseTimings.set(key, { from, to, segments });
    }
    this.hasRealWordTimings = [...this.verseTimings.values()].some(t => t.segments.length > 0);
    this.rebuildTimeline();
    return this.hasRealWordTimings;
  }

  rebuildTimeline() {
    this.timeline = [...this.verseTimings.entries()]
      .map(([key, t]) => ({ key, ...t }))
      .sort((a, b) => a.from - b.from);
  }

  // بعض المصادر ترجع الثواني بدل الملّي ثانية: نكتشف ذلك بمقارنة آخر توقيت بطول الملف
  normalizeUnits(durationMs) {
    if (!this.timeline.length || !durationMs) return false;
    const lastTo = Math.max(...this.timeline.map(t => t.to));
    if (lastTo > 0 && lastTo < durationMs * 0.02) {
      for (const t of this.verseTimings.values()) {
        t.from *= 1000; t.to *= 1000;
        t.segments = t.segments.map(([p, s, e]) => [p, s * 1000, e * 1000]);
      }
      this.rebuildTimeline();
      return true;
    }
    return false;
  }

  // هل التوقيتات تخص هذا الملف فعلًا؟ (آخر آية يجب أن تنتهي قرب نهاية الملف)
  isReliable(durationMs) {
    if (!this.timeline.length || !durationMs) return true;
    const last = Math.max(...this.timeline.map(t => t.to));
    const tolerance = Math.max(15000, durationMs * 0.08);
    return Math.abs(durationMs - last) <= tolerance && this.timeline[0].from < 30000;
  }

  // توزيع تقريبي حسب عدد الحروف عند غياب التوقيتات أو عدم مطابقتها
  buildEstimatedTimings(durationMs) {
    this.verseTimings.clear();
    this.estimated = true;
    this.hasRealWordTimings = false;
    const weights = [...this.versesWords.entries()].map(([key, words]) => {
      const letters = words.map(w => w.text_uthmani || '').join('').replace(ARABIC_LETTERS, '').length;
      return [key, Math.max(3, letters) + 3]; // +3 للوقفة بين الآيات
    });
    const total = weights.reduce((a, [, w]) => a + w, 0);
    if (!total || !durationMs) return false;
    let t = 0;
    for (const [key, w] of weights) {
      const len = (w / total) * durationMs;
      this.verseTimings.set(key, { from: Math.round(t), to: Math.round(t + len), segments: [] });
      t += len;
    }
    this.rebuildTimeline();
    return true;
  }

  // آخر آية بدأت (لا نفقد الآية في الفجوات بين الآيات)
  getActiveStateAtMs(currentMs) {
    const tl = this.timeline;
    if (!tl.length || currentMs < tl[0].from) return null;
    let lo = 0, hi = tl.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tl[mid].from <= currentMs) lo = mid; else hi = mid - 1;
    }
    const t = tl[lo];

    let wordPosition = null;
    if (this.hasRealWordTimings && t.segments.length) {
      for (const [pos, s, e] of t.segments) {
        if (currentMs >= s && currentMs < e) { wordPosition = pos; break; }
        if (s <= currentMs) wordPosition = pos; // نحتفظ بآخر كلمة بدأت أثناء الفجوات
      }
    }
    return {
      verseKey: t.key,
      wordPosition,
      hasRealWordTimings: this.hasRealWordTimings,
      verseStartMs: t.from,
      verseEndMs: t.to
    };
  }

  getVerseStartMs(verseKey) {
    const t = this.verseTimings.get(verseKey);
    return t ? t.from : null;
  }

  getWordStartMs(verseKey, wordPosition) {
    const t = this.verseTimings.get(verseKey);
    if (!t) return null;
    const seg = t.segments.find(s => s[0] === wordPosition);
    return seg ? seg[1] : null;
  }
}
