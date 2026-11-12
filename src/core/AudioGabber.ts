/**
 * AudioGabber — полностью процедурный Web Audio синтезатор:
 *  - lookahead-планировщик по audioCtx.currentTime (шаг 1/16), темп 190 / 220 BPM;
 *  - дисторшн-бочка 909 (sine 240→46 Hz, WaveShaper tanh(x*7.5), lowpass 3200 Hz);
 *  - hoover/acid-лид (2 saw с detune ±18 cents, lowpass Q=9) в фригийском миноре (E-F-G-Bb-B);
 *  - мастер-фильтр музыки: 650 Hz в Хабе, 20000 Hz на уровнях;
 *  - SFX: колёса, ollie/приземление, грайнд, выстрел, хитмаркер, перезарядка, нож, снайпер, дрон, взрывы.
 * Коллбэк onBeat(beatIndex) вызывается синхронно со звуком (через очередь, разбираемую в update()).
 */

export type BeatCallback = (beat: number, bpm: number) => void;

/** Преобразование MIDI-ноты в частоту */
const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** Лид-рифф на 16 шестнадцатых (0 — пауза). E2=40, F2=41, G2=43, Bb2=46, B2=47 */
const LEAD_A: number[] = [40, 0, 40, 41, 0, 43, 0, 40, 0, 46, 0, 47, 43, 0, 41, 0];
const LEAD_B: number[] = [40, 40, 0, 43, 0, 41, 40, 0, 47, 0, 46, 0, 43, 0, 41, 40];
/** Басовые корни на такт: E1, F1, G1, Bb1 */
const BASS_ROOTS: number[] = [28, 29, 31, 34];

export class AudioGabber {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private sfxBus!: GainNode;
  private kickIn!: GainNode;
  private shaper!: WaveShaperNode;
  private leadBus!: GainNode;
  private noise!: AudioBuffer;
  private wheel: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private grind: { noise: AudioBufferSourceNode; gain: GainNode; osc: OscillatorNode; og: GainNode; filter: BiquadFilterNode } | null = null;
  private timerId: number | null = null;
  private step = 0;
  private nextTime = 0;
  private beatQueue: { time: number; beat: number }[] = [];
  private volumeIndex = 0;
  private readonly volumeLevels = [0.85, 0.34, 0.0];
  private filterOpen = false;

  bpm = 190;
  onBeat: BeatCallback | null = null;
  /** Затухающий импульс бита 0..1 — для пульсации HUD и клубных лазеров */
  beatPulse = 0;
  beatCount = 0;

  get ready(): boolean {
    return this.ctx !== null;
  }

  /** Вызывается по клику пользователя (разблокировка AudioContext) */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 650;
    this.musicFilter.Q.value = 0.7;
    this.musicFilter.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.volumeLevels[0];
    this.musicBus.connect(this.musicFilter);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.7;
    this.sfxBus.connect(this.master);

    // Дисторшн бочки: tanh(x * 7.5) → lowpass 3200 Hz → музыкальная шина
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 7.5);
    }
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = curve;
    this.shaper.oversample = '4x';
    const kickLP = ctx.createBiquadFilter();
    kickLP.type = 'lowpass';
    kickLP.frequency.value = 3200;
    this.shaper.connect(kickLP);
    kickLP.connect(this.musicBus);
    this.kickIn = ctx.createGain();
    this.kickIn.gain.value = 1;
    this.kickIn.connect(this.shaper);

    this.leadBus = ctx.createGain();
    this.leadBus.gain.value = 0.16;
    this.leadBus.connect(this.musicBus);

    // Буфер белого шума (2 с) для всех шумовых эффектов
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.startWheelLoop();
    this.startGrindLoop();

    this.nextTime = ctx.currentTime + 0.1;
    this.timerId = window.setInterval(() => this.schedule(), 25);
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
  }

  /** Фильтр музыки: true — открыт (20 kHz на уровнях), false — глухо (650 Hz в Хабе) */
  setFilterOpen(open: boolean): void {
    this.filterOpen = open;
  }

  /** M: 100% → 40% → Mute; возвращает подпись состояния */
  cycleMusicVolume(): string {
    this.volumeIndex = (this.volumeIndex + 1) % this.volumeLevels.length;
    return ['ГРОМКОСТЬ 100%', 'ГРОМКОСТЬ 40%', 'ЗВУК ВЫКЛЮЧЕН'][this.volumeIndex];
  }

  /** Вызывается каждый кадр: диспетчер битов, импульс, сглаживание громкости и фильтра */
  update(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.beatPulse *= Math.exp(-dt * 9);
    const now = ctx.currentTime;
    while (this.beatQueue.length > 0 && this.beatQueue[0].time <= now) {
      const b = this.beatQueue.shift()!;
      if (now - b.time > 0.3) continue; // пропуск при просадке/сворачивании
      this.beatPulse = 1;
      this.beatCount = b.beat;
      this.onBeat?.(b.beat, this.bpm);
    }
    this.musicBus.gain.setTargetAtTime(this.volumeLevels[this.volumeIndex], now, 0.05);
    this.musicFilter.frequency.setTargetAtTime(this.filterOpen ? 20000 : 650, now, 0.35);
  }

  // ---------- Планировщик и музыка ----------

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    while (this.nextTime < ctx.currentTime + 0.12) {
      this.scheduleStep(this.step, this.nextTime);
      this.nextTime += 60 / this.bpm / 4;
      this.step++;
    }
  }

  private scheduleStep(step: number, t: number): void {
    const s16 = step % 16;
    const bar = Math.floor(step / 16);
    // Четвертные удары бочки (с коллбэком бита)
    if (s16 % 4 === 0) {
      this.kick(t, 0.95);
      this.beatQueue.push({ time: t, beat: step / 4 });
    }
    // Брейк-сбивки на 16-х в конце каждого 4-го такта
    if (bar % 4 === 3 && s16 >= 13) this.kick(t, 0.6);
    // Клэп на 2 и 4
    if (s16 === 4 || s16 === 12) this.noiseBurst(t, 0.16, 'bandpass', 1800, 1.2, 0.32, this.musicBus);
    // Хай-хэт на офбитах
    if (s16 % 4 === 2) this.noiseBurst(t, 0.05, 'highpass', 7500, 0.7, s16 % 8 === 6 ? 0.2 : 0.13, this.musicBus);
    // Хувер/рейв-кислота
    const pattern = bar % 2 === 0 ? LEAD_A : LEAD_B;
    if (pattern[s16]) this.acid(t, pattern[s16], 0.13);
    // Басовый саб на четвертях
    if (s16 % 4 === 0) this.bass(t, BASS_ROOTS[bar % 4]);
  }

  private kick(t: number, vol: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(240, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    o.connect(g);
    g.connect(this.kickIn);
    o.start(t);
    o.stop(t + 0.3);
  }

  private acid(t: number, midi: number, dur: number): void {
    const ctx = this.ctx!;
    const f = midiHz(midi + 12);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 9;
    filt.frequency.setValueAtTime(140, t);
    filt.frequency.exponentialRampToValueAtTime(1500, t + 0.03);
    filt.frequency.exponentialRampToValueAtTime(220, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.06);
    for (const detune of [-18, 18]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(filt);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
    filt.connect(g);
    g.connect(this.leadBus);
  }

  private bass(t: number, midi: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = midiHz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 260;
    f.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(f);
    f.connect(g);
    g.connect(this.kickIn);
    o.start(t);
    o.stop(t + 0.25);
  }

  private noiseBurst(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, vol: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 1.2);
    src.stop(t + dur + 0.03);
  }

  private tone(t: number, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, dest: AudioNode = this.sfxBus): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // ---------- Непрерывные петли ----------

  private startWheelLoop(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 600;
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus);
    src.start();
    this.wheel = { src, filter, gain };
  }

  /** Шум колёс: громкость и частота зависят от скорости на земле (в воздухе тишина) */
  setWheel(speed: number, grounded: boolean): void {
    if (!this.wheel || !this.ctx) return;
    const t = this.ctx.currentTime;
    const sp = Math.max(0, Math.min(1, speed / 24));
    this.wheel.gain.gain.setTargetAtTime(grounded ? sp * 0.13 : 0, t, 0.06);
    this.wheel.filter.frequency.setTargetAtTime(380 + speed * 48, t, 0.1);
  }

  private startGrindLoop(): void {
    const ctx = this.ctx!;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 3400;
    filter.Q.value = 4;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus);
    noise.start();
    // Резонансный звон трубы: 1800 Hz + 3400 Hz
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1800;
    const og = ctx.createGain();
    og.gain.value = 0;
    osc.connect(og);
    og.connect(this.sfxBus);
    osc.start();
    this.grind = { noise, gain, osc, og, filter };
  }

  /** Металлический звук грайнда on/off */
  setGrinding(on: boolean): void {
    if (!this.grind || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.grind.gain.gain.setTargetAtTime(on ? 0.14 : 0, t, 0.04);
    this.grind.og.gain.setTargetAtTime(on ? 0.035 : 0, t, 0.04);
    this.grind.osc.frequency.setTargetAtTime(on ? 3400 : 1800, t, 0.08);
  }

  // ---------- Одноразовые SFX ----------

  playShot(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 'sawtooth', 380, 70, 0.14, 0.32);
    this.noiseBurst(t, 0.045, 'highpass', 3000, 0.8, 0.28, this.sfxBus);
  }

  playHitMarker(): void {
    if (!this.ctx) return;
    this.tone(this.ctx.currentTime, 'sine', 1400, 1400, 0.05, 0.2);
  }

  playReload(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 'square', 1800, 1800, 0.025, 0.12);
    this.tone(t + 0.2, 'square', 1200, 1200, 0.03, 0.14);
  }

  playOllie(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.08, 'bandpass', 900, 2, 0.4, this.sfxBus);
    this.tone(t, 'sine', 150, 60, 0.12, 0.3);
  }

  playLand(impact: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.min(0.5, impact / 22);
    this.tone(t, 'sine', 110, 40, 0.15, v);
    this.noiseBurst(t, 0.1, 'lowpass', 600, 0.7, v * 0.6, this.sfxBus);
  }

  playFlip(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.25, 'bandpass', 1200, 1, 0.2, this.sfxBus);
  }

  playKnifeWhoosh(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(600, t);
    f.frequency.exponentialRampToValueAtTime(2800, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + 0.25);
  }

  playKnifeHit(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.07, 'bandpass', 2000, 3, 0.5, this.sfxBus);
    this.tone(t, 'sine', 240, 90, 0.1, 0.3);
  }

  /** Тихий металлический шелест флиппинга бабочки */
  playKnifeTick(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 'square', 4200, 4200, 0.012, 0.03);
    this.noiseBurst(t, 0.02, 'highpass', 6000, 0.7, 0.05, this.sfxBus);
  }

  playFlex(): void {
    if (!this.ctx) return;
    this.tone(this.ctx.currentTime, 'sawtooth', 220, 440, 0.2, 0.22);
  }

  playGrindStart(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.ctx.currentTime, 0.3, 'bandpass', 3400, 3, 0.3, this.sfxBus);
  }

  playSynchro(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1046].forEach((f, i) => this.tone(t + i * 0.06, 'triangle', f, f, 0.12, 0.22));
  }

  playEnemyDie(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.25, 'lowpass', 900, 0.7, 0.4, this.sfxBus);
    this.tone(t, 'sine', 120, 40, 0.2, 0.25);
  }

  playSniperCharge(dur: number): void {
    if (!this.ctx) return;
    this.tone(this.ctx.currentTime, 'sine', 400, 1200, dur, 0.1);
  }

  playSniperBeep(): void {
    if (!this.ctx) return;
    this.tone(this.ctx.currentTime, 'square', 1600, 1600, 0.06, 0.12);
  }

  playSniperShot(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.12, 'bandpass', 2500, 1, 0.5, this.sfxBus);
    this.tone(t, 'square', 900, 200, 0.15, 0.2);
  }

  playDroneWhine(dur: number): void {
    if (!this.ctx) return;
    this.tone(this.ctx.currentTime, 'sawtooth', 900, 2400, dur, 0.12);
  }

  playSlam(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 'sine', 70, 30, 0.5, 0.7);
    this.noiseBurst(t, 0.4, 'lowpass', 400, 0.7, 0.5, this.sfxBus);
  }

  playZap(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 'square', 120, 60, 0.3, 0.15);
    this.noiseBurst(t, 0.3, 'highpass', 2500, 0.8, 0.22, this.sfxBus);
  }

  playExplosion(size: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1200, t);
    f.frequency.exponentialRampToValueAtTime(200, t + 0.7 * size);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6 * size, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.7 * size);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + 0.8 * size);
    this.tone(t, 'sine', 90, 30, 0.5 * size, 0.5);
  }

  playPlayerHurt(): void {
    if (!this.ctx) return;
    this.tone(this.ctx.currentTime, 'square', 180, 90, 0.15, 0.2);
  }

  playDeath(): void {
    if (!this.ctx) return;
    this.tone(this.ctx.currentTime, 'sawtooth', 200, 40, 1.0, 0.4);
  }

  playAcidSplash(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.4, 'bandpass', 1400, 1.5, 0.45, this.sfxBus);
    this.tone(t, 'sawtooth', 300, 80, 0.4, 0.2);
  }

  playMenuClick(): void {
    if (!this.ctx) return;
    this.tone(this.ctx.currentTime, 'square', 880, 880, 0.04, 0.12);
  }

  playRailClack(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.ctx.currentTime, 0.05, 'bandpass', 4200, 2, 0.2, this.sfxBus);
  }
}
