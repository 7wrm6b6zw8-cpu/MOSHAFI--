export class WordSyncEngine {
  constructor() {
    this.verseTimings = new Map(); // verseKey -> { timestamp_from, timestamp_to, segments: [[wordIdx, startMs, endMs], ...] }
    this.versesWords = new Map();  // verseKey -> [{ position, text_uthmani }]
    this.hasRealWordTimings = false;
    this.estimated = false;
  }

  // بديل عند غياب verse_timings: توزيع تقريبي للزمن على الآيات حسب عدد الكلمات (يُعرض للمستخدم كتقريبي)
  buildEstimatedTimings(durationMs) {
    this.verseTimings.clear();
    this.estimated = true;
    this.hasRealWordTimings = false;
    const entries = [...this.versesWords.entries()];
    const total = entries.reduce((a, [, w]) => a + Math.max(1, w.length), 0);
    if (!total || !durationMs) return false;
    let t = 0;
    for (const [key, words] of entries) {
      const len = (Math.max(1, words.length) / total) * durationMs;
      this.verseTimings.set(key, { from: Math.round(t), to: Math.round(t + len), segments: [] });
      t += len;
    }
    return true;
  }

  loadChapterData(verses, audioFileMeta) {
    this.verseTimings.clear();
    this.versesWords.clear();
    this.hasRealWordTimings = false;
    this.estimated = false;

    if (Array.isArray(verses)) {
      for (const v of verses) {
        const words = (v.words || []).filter(w => w.char_type_name === 'word');
        this.versesWords.set(v.verse_key, words);
      }
    }

    const rawTimings = audioFileMeta?.verse_timings || [];
    for (const vt of rawTimings) {
      const segments = Array.isArray(vt.segments) ? vt.segments : [];
      if (segments.length > 0) {
        this.hasRealWordTimings = true;
      }
      this.verseTimings.set(vt.verse_key, {
        from: vt.timestamp_from,
        to: vt.timestamp_to,
        segments
      });
    }

    return this.hasRealWordTimings;
  }

  getActiveStateAtMs(currentMs) {
    let activeVerseKey = null;
    let activeTiming = null;

    for (const [vKey, timing] of this.verseTimings.entries()) {
      if (currentMs >= timing.from && currentMs <= timing.to) {
        activeVerseKey = vKey;
        activeTiming = timing;
        break;
      }
    }

    if (!activeVerseKey || !activeTiming) {
      return null;
    }

    let activeWordPosition = null;
    if (this.hasRealWordTimings && activeTiming.segments.length > 0) {
      for (const seg of activeTiming.segments) {
        // Quran.com segment format: [word_position (1-based), start_ms, end_ms]
        if (Array.isArray(seg) && seg.length >= 3) {
          const [wordPos, startMs, endMs] = seg;
          if (currentMs >= startMs && currentMs <= endMs) {
            activeWordPosition = wordPos;
            break;
          }
        }
      }
    }

    return {
      verseKey: activeVerseKey,
      wordPosition: activeWordPosition,
      hasRealWordTimings: this.hasRealWordTimings,
      verseStartMs: activeTiming.from,
      verseEndMs: activeTiming.to
    };
  }

  getVerseStartMs(verseKey) {
    const t = this.verseTimings.get(verseKey);
    return t ? t.from : null;
  }

  getWordStartMs(verseKey, wordPosition) {
    const t = this.verseTimings.get(verseKey);
    if (!t || !Array.isArray(t.segments)) return null;
    const seg = t.segments.find(s => Array.isArray(s) && s[0] === wordPosition);
    return seg ? seg[1] : null;
  }
}
