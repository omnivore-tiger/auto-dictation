/**
 * 语音合成（TTS）封装。
 *
 * 浏览器 speechSynthesis 有几个广为人知的坑，这里统一抹平：
 *   1. 首次 getVoices() 可能返回空数组，要等 voiceschanged；
 *   2. Chrome 长时间朗读会"卡住"，需要周期性 resume()；
 *   3. cancel() 之后立刻 speak() 可能被吞掉，要等一小会儿；
 *   4. 部分浏览器不支持 pause()，要用 cancel + 重念的方式兜底。
 */

const CHROME_RESUME_INTERVAL_MS = 5000;
const CANCEL_SETTLE_MS = 60;

/** @typedef {{ uri: string, name: string, lang: string, localService: boolean, voice: SpeechSynthesisVoice }} VoiceInfo */

export function isSpeechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

/**
 * 等待语音列表就绪（最多等 timeout 毫秒）。
 * @param {number} [timeoutMs]
 * @returns {Promise<SpeechSynthesisVoice[]>}
 */
export function loadVoices(timeoutMs = 3000) {
  if (!isSpeechSupported()) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const existing = synth.getVoices();
  if (existing.length > 0) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      synth.removeEventListener?.('voiceschanged', onChanged);
      resolve(synth.getVoices());
    };
    const onChanged = () => finish();
    synth.addEventListener?.('voiceschanged', onChanged);
    setTimeout(finish, timeoutMs);
  });
}

/**
 * 从语音列表里挑一个合适的中文/英文声音。
 * @param {SpeechSynthesisVoice[]} voices
 * @param {'zh'|'en'} kind
 * @param {string} [preferredURI]
 */
export function pickVoice(voices, kind, preferredURI) {
  const list = voices ?? [];
  if (preferredURI) {
    const exact = list.find((v) => v.voiceURI === preferredURI);
    if (exact) return exact;
  }
  const langPrefix = kind === 'zh' ? 'zh' : 'en';
  const candidates = list.filter((v) => String(v.lang || '').toLowerCase().startsWith(langPrefix));
  if (candidates.length === 0) return null;
  // 优先本地声音（离线可用、延迟低），再优先中文普通话/英文美音
  const score = (v) => {
    const lang = String(v.lang || '').toLowerCase();
    let value = 0;
    if (v.localService) value += 4;
    if (kind === 'zh' && /^zh[-_]?(cn|hans)/.test(lang)) value += 3;
    if (kind === 'en' && /^en[-_]?(us|gb)/.test(lang)) value += 2;
    if (/xiaoxiao|huihui|yaoyao|kangkang|tingting|google|microsoft/i.test(v.name)) value += 1;
    return value;
  };
  return candidates.slice().sort((a, b) => score(b) - score(a))[0];
}

/**
 * 按语言分组，给设置界面用。
 * @param {SpeechSynthesisVoice[]} voices
 * @returns {{ zh: VoiceInfo[], en: VoiceInfo[], other: VoiceInfo[] }}
 */
export function groupVoices(voices) {
  /** @type {{ zh: VoiceInfo[], en: VoiceInfo[], other: VoiceInfo[] }} */
  const out = { zh: [], en: [], other: [] };
  for (const voice of voices ?? []) {
    /** @type {VoiceInfo} */
    const info = {
      uri: voice.voiceURI,
      name: voice.name,
      lang: String(voice.lang || ''),
      localService: Boolean(voice.localService),
      voice
    };
    const lang = info.lang.toLowerCase();
    if (lang.startsWith('zh')) out.zh.push(info);
    else if (lang.startsWith('en')) out.en.push(info);
    else out.other.push(info);
  }
  return out;
}

/**
 * 播放器：按队列依次朗读，支持暂停 / 继续 / 跳过 / 重听。
 */
export class SpeechPlayer {
  constructor() {
    /** @type {'idle'|'playing'|'paused'} */
    this.state = 'idle';
    /** @type {import('./scheduler.js').Step[]} */
    this.steps = [];
    this.index = 0;
    /** @type {Partial<import('./model.js').Settings>} */
    this.settings = {};
    /** @type {SpeechSynthesisVoice[]} */
    this.voices = [];
    /** 无声练习模式：照常走完"念几遍、停多久"的节奏，但不发声 */
    this.muted = false;
    /** @type {Map<string, (event: { type: string, detail?: any }) => void>} */
    this.listeners = new Map();
    this.currentItemIndex = -1;
    /** @type {number|null} */
    this.waitTimer = null;
    /** @type {number|null} */
    this.resumeTimer = null;
    /** @type {number|null} */
    this.waitDeadline = null;
    /** @type {number} */
    this.remainingWaitMs = 0;
    /** @type {SpeechSynthesisUtterance|null} */
    this.utterance = null;
    /** 用于让"暂停/跳过"立刻打断正在进行的等待 */
    this.abortWait = false;
    /** 记录已播报的朗读次数，用于进度显示 */
    this.spokenCount = 0;
  }

  /** @param {(event: { type: string, detail?: any }) => void} handler */
  on(handler) {
    const key = Math.random().toString(36).slice(2);
    this.listeners.set(key, handler);
    return () => this.listeners.delete(key);
  }

  emit(type, detail) {
    for (const handler of this.listeners.values()) {
      try {
        handler({ type, detail });
      } catch (error) {
        console.error('播放器事件处理出错：', error);
      }
    }
  }

  /**
   * 载入队列并准备播放（不会自动开始）。
   * @param {import('./scheduler.js').Step[]} steps
   * @param {Partial<import('./model.js').Settings>} settings
   * @param {SpeechSynthesisVoice[]} voices
   */
  load(steps, settings, voices) {
    this.stop();
    this.steps = steps ?? [];
    this.settings = settings ?? {};
    this.voices = voices ?? [];
    this.muted = Boolean(this.settings.muted);
    this.index = 0;
    this.spokenCount = 0;
    this.currentItemIndex = -1;
    this.state = 'idle';
  }

  /** 开始或继续播放 */
  async play() {
    if (this.state === 'playing') return;
    if (this.steps.length === 0) {
      this.emit('error', { message: '没有可播报的词条，请先添加词语。' });
      return;
    }
    if (!isSpeechSupported() && !this.muted) {
      // 没有语音引擎时自动降级为"无声练习"，至少保证节奏和流程可用
      this.muted = true;
      this.emit('muted', { reason: 'unsupported' });
    }
    if (this.index >= this.steps.length) {
      this.index = 0;
      this.spokenCount = 0;
    }
    this.state = 'playing';
    this.emit('state', { state: this.state });
    this.startResumeKeepAlive();
    await this.runLoop();
  }

  /** 暂停 */
  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.abortWait = true;
    this.clearWaitTimer();
    this.stopResumeKeepAlive();
    try {
      window.speechSynthesis.cancel();
    } catch (error) {
      console.warn('暂停失败：', error);
    }
    this.emit('state', { state: this.state });
  }

  /** 停止并复位 */
  stop() {
    this.abortWait = true;
    this.clearWaitTimer();
    this.stopResumeKeepAlive();
    if (isSpeechSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch (error) {
        console.warn('停止失败：', error);
      }
    }
    this.state = 'idle';
    this.utterance = null;
    this.emit('state', { state: this.state });
  }

  /** 跳到下一个朗读步骤（跳过当前词的剩余重复与停顿） */
  skipToNext() {
    const nextSpeak = this.findNextSpeakIndex(this.index);
    if (nextSpeak === -1) {
      this.finish();
      return;
    }
    this.abortWait = true;
    this.clearWaitTimer();
    if (isSpeechSupported()) window.speechSynthesis.cancel();
    this.index = nextSpeak;
    this.emit('index', { index: this.index });
    if (this.state === 'paused') {
      // 暂停状态下只移动指针，等用户点继续
      this.emit('state', { state: this.state });
    }
  }

  /** 重听：回到当前词的第一个步骤重念 */
  replayCurrent() {
    const itemIndex = this.currentItemIndex;
    if (itemIndex < 0) {
      this.index = 0;
    } else {
      const found = this.steps.findIndex((step) => step.itemIndex === itemIndex);
      this.index = found >= 0 ? found : 0;
    }
    this.abortWait = true;
    this.clearWaitTimer();
    if (isSpeechSupported()) window.speechSynthesis.cancel();
    this.emit('index', { index: this.index });
    if (this.state !== 'playing') {
      void this.play();
    }
  }

  /**
   * 跳到指定词的开始处（点击词条列表里的"从这里播"）。
   * @param {number} itemIndex
   */
  seekToItem(itemIndex) {
    const found = this.steps.findIndex((step) => step.itemIndex === itemIndex);
    if (found === -1) return;
    this.abortWait = true;
    this.clearWaitTimer();
    if (isSpeechSupported()) window.speechSynthesis.cancel();
    this.index = found;
    this.spokenCount = this.steps.slice(0, found).filter((s) => s.kind === 'speak').length;
    this.emit('index', { index: this.index });
    if (this.state !== 'playing') void this.play();
  }

  finish() {
    this.state = 'idle';
    this.index = this.steps.length;
    this.clearWaitTimer();
    this.stopResumeKeepAlive();
    this.emit('index', { index: this.index });
    this.emit('state', { state: this.state });
    this.emit('done', {});
  }

  // ---------------------------------------------------------------- 内部实现

  async runLoop() {
    while (this.state === 'playing' && this.index < this.steps.length) {
      const step = this.steps[this.index];
      if (step.itemIndex >= 0 && step.itemIndex !== this.currentItemIndex) {
        this.currentItemIndex = step.itemIndex;
        this.emit('item', { itemIndex: step.itemIndex });
      }
      this.emit('index', { index: this.index, step });

      if (step.kind === 'wait') {
        const completed = await this.doWait(step.ms);
        if (!completed || this.state !== 'playing') return;
        this.index += 1;
        continue;
      }

      const ok = await this.doSpeak(step.text, step.role, step.estimatedMs);
      if (this.state !== 'playing') return;
      if (ok) {
        this.spokenCount += 1;
        this.emit('spoken', { spokenCount: this.spokenCount, step });
      }
      this.index += 1;
    }

    if (this.state === 'playing' && this.index >= this.steps.length) {
      this.finish();
    }
  }

  /**
   * 念一句话。返回是否正常念完（被取消 / 出错时返回 false，但仍继续流程）。
   * @param {string} text
   * @param {string} role
   */
  doSpeak(text, role, estimatedMs = 600) {
    // 无声练习模式：留出与真实朗读相近的时间，让节奏保持一致
    if (this.muted || !isSpeechSupported()) {
      return this.doWait(estimatedMs).then((completed) => {
        if (!completed) return false;
        this.emit('silent', { text, role });
        return true;
      });
    }
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      // Chrome 在 cancel 之后马上 speak 会丢句，先让出一次事件循环
      synth.cancel();
      setTimeout(() => {
        if (this.state !== 'playing') return resolve(false);
        const utterance = new SpeechSynthesisUtterance(text);
        const isEnglish = role === 'en';
        utterance.lang = isEnglish ? 'en-US' : 'zh-CN';
        utterance.rate = Number(this.settings.rate) || 1;
        utterance.pitch = Number(isEnglish ? this.settings.enPitch : this.settings.zhPitch) || 1;
        utterance.volume = 1;
        const voice = pickVoice(this.voices, isEnglish ? 'en' : 'zh', isEnglish ? this.settings.enVoiceURI : this.settings.zhVoiceURI);
        if (voice) {
          utterance.voice = voice;
          if (voice.lang) utterance.lang = voice.lang;
        }
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          this.utterance = null;
          resolve(value);
        };
        utterance.onend = () => done(true);
        utterance.onerror = (event) => {
          const reason = String(event?.error || '');
          // interrupted/canceled 是我们自己取消导致的，不算错误
          if (reason && !['interrupted', 'canceled', 'cancelled'].includes(reason)) {
            console.warn('语音播报出错：', reason);
          }
          done(false);
        };
        this.utterance = utterance;
        try {
          synth.speak(utterance);
        } catch (error) {
          console.warn('speak 调用失败：', error);
          done(false);
        }
      }, CANCEL_SETTLE_MS);
    });
  }

  /**
   * 等待一段时间；暂停时会记录剩余时间，继续时接着等。
   * @param {number} ms
   * @returns {Promise<boolean>} 正常等完返回 true，被中断返回 false
   */
  doWait(ms) {
    const total = this.remainingWaitMs > 0 ? this.remainingWaitMs : ms;
    this.remainingWaitMs = 0;
    this.abortWait = false;
    const deadline = Date.now() + total;
    this.waitDeadline = deadline;
    return new Promise((resolve) => {
      this.waitTimer = window.setInterval(() => {
        if (this.abortWait || this.state !== 'playing') {
          // 暂停：记下还剩多久，继续时接着等
          this.remainingWaitMs = Math.max(0, deadline - Date.now());
          this.clearWaitTimer();
          resolve(false);
          return;
        }
        if (Date.now() >= deadline) {
          this.clearWaitTimer();
          resolve(true);
        }
      }, 50);
    });
  }

  clearWaitTimer() {
    if (this.waitTimer !== null) {
      window.clearInterval(this.waitTimer);
      this.waitTimer = null;
    }
  }

  startResumeKeepAlive() {
    this.stopResumeKeepAlive();
    this.resumeTimer = window.setInterval(() => {
      if (this.state === 'playing') {
        try {
          window.speechSynthesis.resume();
        } catch {
          /* 忽略 */
        }
      }
    }, CHROME_RESUME_INTERVAL_MS);
  }

  stopResumeKeepAlive() {
    if (this.resumeTimer !== null) {
      window.clearInterval(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  /**
   * 找到 index 之后（含 index）的下一个朗读步骤。
   * @param {number} from
   */
  findNextSpeakIndex(from) {
    for (let i = Math.max(0, from); i < this.steps.length; i += 1) {
      if (this.steps[i].kind === 'speak') return i;
    }
    return -1;
  }
}
