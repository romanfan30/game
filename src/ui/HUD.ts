import { CalloutTone } from '../combat/ComboSystem';

/** Кнопка экрана меню */
export interface ScreenButton {
  label: string;
  onClick: () => void;
}

/** Пункт меню/экрана: заголовок, строки текста и кнопки */
export interface ScreenSpec {
  title: string;
  lines: string[];
  buttons: ScreenButton[];
  /** Класс для специального оформления (например, lose — экран смерти) */
  cls?: string;
  /** Крупный ранг (экран итогов) */
  rank?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * HUD: очки, множитель, таймер «ВАЙБ», HP, патроны, слоты, прицел, ромб автонаводки, мемы, полоска босса и меню.
 * Вся разметка создаётся в #ui; стили — в style.css.
 */
export class HUD {
  private readonly hud: HTMLElement;
  private readonly score: HTMLElement;
  private readonly mult: HTMLElement;
  private readonly vibeBar: HTMLElement;
  private readonly hpBar: HTMLElement;
  private readonly ammo: HTMLElement;
  private readonly reloading: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly crosshair: HTMLElement;
  private readonly lock: HTMLElement;
  private readonly lockLabel: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly railHint: HTMLElement;
  private readonly callouts: HTMLElement;
  private readonly bigMsg: HTMLElement;
  private readonly bossWrap: HTMLElement;
  private readonly bossFill: HTMLElement;
  private readonly bossName: HTMLElement;
  private readonly bossPhase: HTMLElement;
  private readonly bossSay: HTMLElement;
  private readonly levelTitle: HTMLElement;
  private readonly flashHurtEl: HTMLElement;
  private readonly flashSyncEl: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly hpLabel: HTMLElement;
  private readonly tierWarn: HTMLElement;
  private readonly speedEl: HTMLElement;
  private readonly lockEl: HTMLElement;
  private toastT = 0;
  private bigT = 0;
  private sayT = 0;
  private levelT = 0;
  private hurtT = 0;
  private syncT = 0;
  private hitT = 0;
  private lastMult = -1;
  private flashed = false;

  constructor(root: HTMLElement, public readonly customPanel: HTMLElement) {
    this.hud = el('div', 'hud');
    root.appendChild(this.hud);

    const tl = el('div', 'hud-tl');
    this.levelTitle = el('div', 'level-title');
    this.railHint = el('div', 'rail-hint', '[SPACE: ГРАЙНД]');
    this.speedEl = el('div', 'hud-speed');
    this.speedEl.style.cssText = 'font-size:14px;color:#00f0ff;text-shadow:0 0 6px #00f0ff;margin-top:6px';
    tl.append(this.speedEl);
    this.hud.append(tl, this.levelTitle);

    const tr = el('div', 'hud-tr');
    this.score = el('div', 'score', '000000');
    this.mult = el('div', 'mult', 'x1');
    const vibeWrap = el('div', 'vibe-wrap');
    this.vibeBar = el('div', 'vibe-bar');
    vibeWrap.appendChild(this.vibeBar);
    const vibeLabel = el('div', 'vibe-label', 'ВАЙБ-ТАЙМЕР');
    tr.append(this.score, this.mult, vibeWrap, vibeLabel);
    this.hud.appendChild(tr);

    const bl = el('div', 'hud-bl');
    this.hpLabel = el('div', 'hp-label', 'HP 100');
    const hpWrap = el('div', 'hp-wrap');
    this.hpBar = el('div', 'hp-bar');
    hpWrap.appendChild(this.hpBar);
    const slotsWrap = el('div', 'slots');
    for (const label of ['1 ПП', '2 НОЖ', '3 ПЕРЧ']) {
      const s = el('div', 'slot', label);
      slotsWrap.appendChild(s);
      this.slots.push(s);
    }
    bl.append(this.hpLabel, hpWrap, slotsWrap);
    this.hud.appendChild(bl);

    const br = el('div', 'hud-br');
    this.ammo = el('div', 'ammo', '32');
    this.ammo.appendChild(el('small', undefined, ' / 32'));
    this.reloading = el('div', 'reloading', 'ПЕРЕЗАРЯДКА…');
    this.reloading.style.display = 'none';
    this.controls = el('div', 'controls-panel');
    this.controls.innerHTML =
      '<b>W/S</b> газ/тормоз &nbsp; <b>A/D</b> карвинг &nbsp; <b>SPACE</b> трюк<br>' +
      '<b>ЛКМ</b> огонь/нож &nbsp; <b>ПКМ</b> прицел &nbsp; <b>R</b> перезарядка<br>' +
      '<b>1/2/3</b> слоты &nbsp; <b>C</b> верстак &nbsp; <b>M</b> громкость &nbsp; <b>ESC</b> меню';
    br.append(this.ammo, this.reloading, this.controls);
    this.hud.appendChild(br);

    this.crosshair = el('div', 'crosshair');
    this.crosshair.innerHTML = '<i></i>';
    this.lock = el('div', 'lock');
    this.lockLabel = el('div', 'lock-label', '[АВТО-ЦЕЛЬ]');
    this.lockLabel.style.cssText = 'position:absolute;left:24px;top:-26px;white-space:nowrap;font-size:13px;color:#39ff14;text-shadow:0 0 6px #39ff14;transform:rotate(-45deg)';
    this.lockEl = this.lock;
    this.lock.appendChild(this.lockLabel);
    this.hitmarker = el('div', 'hitmarker');
    this.hud.append(this.crosshair, this.lock, this.hitmarker, this.railHint);

    this.callouts = el('div', 'callouts');
    this.bigMsg = el('div', 'big-msg');
    this.hud.append(this.callouts, this.bigMsg);

    this.bossWrap = el('div', 'boss-wrap');
    this.bossName = el('div', 'boss-name', 'DJ АРХОНТ-909 & МС ГИГА-ЯЩЕР');
    const bossBar = el('div', 'boss-bar');
    this.bossFill = el('div', 'boss-fill');
    bossBar.appendChild(this.bossFill);
    this.bossPhase = el('div', 'boss-phase');
    this.bossWrap.append(this.bossName, bossBar, this.bossPhase);
    this.bossSay = el('div', 'boss-say');
    this.hud.append(this.bossWrap, this.bossSay);

    this.flashHurtEl = el('div', 'flash-hurt');
    this.flashSyncEl = el('div', 'flash-sync');
    this.hud.append(this.flashHurtEl, this.flashSyncEl);
    this.tierWarn = el('div', 'flash-edge');
    this.hud.appendChild(this.tierWarn);

    this.toast = el('div', 'toast');
    this.hud.appendChild(this.toast);

    this.screen = el('div', 'screen');
    root.appendChild(this.screen);
    this.hideLock();
    this.hideBoss();
  }

  /** Текст полосы HP и цвет полоски */
  setHP(hp: number, max: number): void {
    const k = Math.max(0, hp / max);
    this.hpBar.style.width = `${k * 100}%`;
    this.hpLabel.textContent = `HP ${Math.ceil(hp)}`;
  }

  setScore(score: number, mult: number, timerFrac: number, beat: number): void {
    this.score.textContent = score.toString().padStart(6, '0');
    if (mult !== this.lastMult) {
      this.mult.textContent = `x${mult}`;
      this.lastMult = mult;
    }
    this.mult.style.transform = `scale(${1 + beat * 0.12})`;
    this.vibeBar.style.width = `${Math.max(0, Math.min(1, timerFrac)) * 100}%`;
  }

  setSpeed(kmh: number): void {
    this.speedEl.textContent = `${Math.round(kmh)} км/ч`;
  }

  setAmmo(ammo: number, reloading: boolean): void {
    this.ammo.firstChild!.textContent = String(ammo);
    this.reloading.style.display = reloading ? 'block' : 'none';
    this.ammo.style.color = ammo <= 6 ? '#ff1133' : '';
  }

  setSlot(slot: number): void {
    this.slots.forEach((s, i) => s.classList.toggle('active', i + 1 === slot));
  }

  /** Прицел: в режиме плеча — центр экрана; иначе — ромб автонаводки в точке цели */
  setCrosshair(visible: boolean): void {
    this.crosshair.style.display = visible ? 'block' : 'none';
  }

  setLock(x: number | null, y: number | null): void {
    if (x === null || y === null) {
      this.hideLock();
      return;
    }
    this.lockEl.style.display = 'block';
    this.lockEl.style.left = `${x}px`;
    this.lockEl.style.top = `${y}px`;
  }

  hideLock(): void {
    this.lockEl.style.display = 'none';
  }

  /** Подсказка рельса у ног игрока */
  setRailHint(x: number | null, y: number | null, text = '[SPACE: ГРАЙНД]'): void {
    if (x === null || y === null) {
      this.railHint.style.display = 'none';
      return;
    }
    this.railHint.textContent = text;
    this.railHint.style.display = 'block';
    this.railHint.style.left = `${x}px`;
    this.railHint.style.top = `${y}px`;
  }

  /** Хитмаркер: белый крест на 0.18 с, при убийстве — красный */
  hitMark(kill: boolean): void {
    this.hitmarker.style.opacity = '1';
    this.hitmarker.style.filter = kill ? 'hue-rotate(300deg) saturate(3)' : '';
    this.hitT = 0.18;
  }

  /** Всплывающая мемная надпись со случайным наклоном */
  callout(text: string, tone: CalloutTone): void {
    const d = el('div', `callout ${tone}`, text);
    d.style.transform = `rotate(${(Math.random() * 24 - 12).toFixed(1)}deg)`;
    this.callouts.appendChild(d);
    while (this.callouts.childElementCount > 6) this.callouts.firstElementChild?.remove();
    setTimeout(() => d.remove(), 2200);
  }

  /** Крупное сообщение в центре (например, «ПОТЕРЯЛ ВАЙБ») */
  bigMessage(text: string, seconds = 2.5): void {
    this.bigMsg.textContent = text;
    this.bigMsg.classList.add('on');
    this.bigT = seconds;
  }

  /** Тост-подсказка внизу экрана */
  showToast(text: string, seconds = 2): void {
    this.toast.textContent = text;
    this.toast.classList.add('on');
    this.toastT = seconds;
  }

  showLevelTitle(text: string): void {
    this.levelTitle.textContent = text;
    this.levelTitle.classList.add('on');
    this.levelT = 3.5;
  }

  setHUDVisible(visible: boolean): void {
    this.hud.style.display = visible ? 'block' : 'none';
  }

  /** Полоска здоровья босса и фаза */
  showBoss(frac: number, phase: string): void {
    this.bossWrap.style.display = 'block';
    this.bossFill.style.width = `${Math.max(0, frac) * 100}%`;
    this.bossPhase.textContent = phase;
  }

  hideBoss(): void {
    this.bossWrap.style.display = 'none';
  }

  /** Реплика босса/МС Гига-Ящера */
  bossLine(text: string): void {
    this.bossSay.textContent = text;
    this.bossSay.classList.add('on');
    this.sayT = 3.6;
  }

  flashHurt(): void {
    this.hurtT = 0.25;
    this.flashHurtEl.style.opacity = '1';
  }

  flashSync(): void {
    this.syncT = 0.3;
    this.flashSyncEl.style.opacity = '1';
  }

  /** Меню/экраны: заголовок, строки, кнопки; cls — особый стиль */
  showScreen(spec: ScreenSpec): void {
    this.screen.innerHTML = '';
    if (spec.cls) this.screen.classList.add(spec.cls);
    else this.screen.className = 'screen';
    this.screen.classList.add('on');
    const box = el('div', 'screen-inner');
    box.appendChild(el('h1', undefined, spec.title));
    for (const line of spec.lines) box.appendChild(el('p', undefined, line));
    if (spec.rank) box.appendChild(el('div', 'rank-big', spec.rank));
    for (const b of spec.buttons) {
      const btn = el('button', 'btn', b.label);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        b.onClick();
      });
      box.appendChild(btn);
    }
    this.screen.appendChild(box);
  }

  hideScreen(): void {
    this.screen.classList.remove('on');
    this.screen.innerHTML = '';
  }

  isScreenOpen(): boolean {
    return this.screen.classList.contains('on');
  }

  showCustomizer(open: boolean): void {
    this.customPanel.classList.toggle('on', open);
  }

  /** Анимация таймеров HUD */
  update(dt: number): void {
    const dec = (v: number): number => Math.max(0, v - dt);
    this.toastT = dec(this.toastT);
    if (this.toastT === 0) this.toast.classList.remove('on');
    this.bigT = dec(this.bigT);
    if (this.bigT === 0) this.bigMsg.classList.remove('on');
    this.sayT = dec(this.sayT);
    if (this.sayT === 0) this.bossSay.classList.remove('on');
    this.levelT = dec(this.levelT);
    if (this.levelT === 0) this.levelTitle.classList.remove('on');
    this.hurtT = dec(this.hurtT);
    this.flashHurtEl.style.opacity = String(this.hurtT / 0.25);
    this.syncT = dec(this.syncT);
    this.flashSyncEl.style.opacity = String(this.syncT / 0.3);
    this.hitT = dec(this.hitT);
    this.hitmarker.style.opacity = String(this.hitT / 0.18);
    if (!this.flashed) this.flashed = true;
  }
}
