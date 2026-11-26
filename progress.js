// الورد اليومي وتتبّع الختمة: الصفحة تُحتسب مقروءة بعد بقائها مفتوحة فترة قصيرة
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export class ProgressTracker {
  constructor(storage) { this.storage = storage; }

  _state() {
    const s = this.storage.getSettings();
    return {
      target: s.wirdTarget || 5,
      log: s.wirdLog || {},
      khatma: s.khatma || { startedAt: null, pages: [], completed: 0 }
    };
  }

  markPage(page) {
    const { target, log: oldLog, khatma } = this._state();
    const today = dayKey();
    const log = { ...oldLog };
    const todaySet = new Set(log[today] || []);
    const added = !todaySet.has(page);
    todaySet.add(page);
    log[today] = [...todaySet];
    const keys = Object.keys(log).sort();
    while (keys.length > 60) delete log[keys.shift()];

    const k = { startedAt: khatma.startedAt || today, completed: khatma.completed || 0, pages: [...new Set([...(khatma.pages || []), page])].sort((a, b) => a - b) };
    let completedNow = false;
    if (k.pages.length >= 604) { k.completed += 1; k.pages = []; k.startedAt = today; completedNow = true; }

    this.storage.saveSettings({ wirdLog: log, khatma: k });
    return { added, completedNow, todayCount: todaySet.size, target };
  }

  summary() {
    const { target, log, khatma } = this._state();
    const today = dayKey();
    const todayCount = (log[today] || []).length;
    let streak = 0;
    const d = new Date();
    if (todayCount < target) d.setDate(d.getDate() - 1); // اليوم لم يكتمل بعد: ابدأ من أمس
    while ((log[dayKey(d)] || []).length >= target) { streak++; d.setDate(d.getDate() - 1); }
    const read = (khatma.pages || []).length;
    return { target, todayCount, streak, khatmaRead: read, khatmaPct: Math.round((read / 604) * 100), completed: khatma.completed || 0 };
  }

  setTarget(n) {
    const v = Math.max(1, Math.min(60, parseInt(n, 10) || 5));
    this.storage.saveSettings({ wirdTarget: v });
  }

  resetKhatma() {
    const k = this._state().khatma;
    this.storage.saveSettings({ khatma: { startedAt: dayKey(), pages: [], completed: k.completed || 0 } });
  }
}
