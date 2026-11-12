import { CustomizerConfig } from '../customization/CustomizerConfig';
import { makePreviewCanvas, PALETTE, PATTERN_NAMES } from '../customization/SkinGenerator';
import { CustomTarget, WeaponSlot } from '../types';

const TABS: { target: CustomTarget; label: string }[] = [
  { target: 'player', label: 'ИГРОК / ПЕРЧАТКИ' },
  { target: 'board', label: 'СКЕЙТ' },
  { target: 'gun', label: 'ПУШКА' },
  { target: 'knife', label: 'НОЖ-БАБОЧКА' },
];

const PREVIEW: { slot: WeaponSlot; label: string }[] = [
  { slot: 1, label: 'В РУКАХ: ПП' },
  { slot: 2, label: 'В РУКАХ: НОЖ' },
  { slot: 3, label: 'ТОЛЬКО ПЕРЧАТКИ' },
];

/**
 * CustomizerUI: панель «Верстак кастомизации» — 4 вкладки, 12 цветов основного и вторичного,
 * 7 пиксельных узоров с превью, предпросмотр слота на модели. Изменения мгновенны (onChange).
 */
export class CustomizerUI {
  readonly panel: HTMLElement;
  private tab: CustomTarget = 'player';
  private readonly tabBtns = new Map<CustomTarget, HTMLElement>();
  private readonly primarySw: HTMLElement[] = [];
  private readonly secondarySw: HTMLElement[] = [];
  private readonly patternEls: HTMLElement[] = [];
  private readonly previewBtns: HTMLElement[] = [];

  constructor(
    root: HTMLElement,
    private readonly cfg: CustomizerConfig,
    private readonly onPreview: (slot: WeaponSlot) => void,
    private readonly onClose: () => void,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'custom-panel';
    root.appendChild(this.panel);
    this.build();
    cfg.onChange(() => this.refresh());
  }

  private build(): void {
    const h2 = document.createElement('h2');
    h2.textContent = 'ВЕРСТАК КАСТОМИЗАЦИИ';
    this.panel.appendChild(h2);

    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    for (const t of TABS) {
      const b = document.createElement('div');
      b.className = 'tab';
      b.textContent = t.label;
      b.addEventListener('click', () => this.selectTab(t.target));
      tabs.appendChild(b);
      this.tabBtns.set(t.target, b);
    }
    this.panel.appendChild(tabs);

    this.panel.appendChild(this.sectTitle('ОСНОВНОЙ ЦВЕТ'));
    const sw1 = document.createElement('div');
    sw1.className = 'swatches';
    PALETTE.forEach((c, i) => {
      const s = document.createElement('div');
      s.className = 'swatch';
      s.style.background = `#${c.hex.toString(16).padStart(6, '0')}`;
      s.title = c.name;
      s.addEventListener('click', () => this.set({ primary: i }));
      sw1.appendChild(s);
      this.primarySw.push(s);
    });
    this.panel.appendChild(sw1);

    this.panel.appendChild(this.sectTitle('ЦВЕТ УЗОРА'));
    const sw2 = document.createElement('div');
    sw2.className = 'swatches';
    PALETTE.forEach((c, i) => {
      const s = document.createElement('div');
      s.className = 'swatch';
      s.style.background = `#${c.hex.toString(16).padStart(6, '0')}`;
      s.title = c.name;
      s.addEventListener('click', () => this.set({ secondary: i }));
      sw2.appendChild(s);
      this.secondarySw.push(s);
    });
    this.panel.appendChild(sw2);

    this.panel.appendChild(this.sectTitle('УЗОР'));
    const pats = document.createElement('div');
    pats.className = 'patterns';
    PATTERN_NAMES.forEach((name, i) => {
      const p = document.createElement('div');
      p.className = 'pattern';
      p.addEventListener('click', () => this.set({ pattern: i }));
      p.appendChild(document.createElement('span'));
      p.lastElementChild!.textContent = name;
      this.patternEls.push(p);
      pats.appendChild(p);
    });
    this.panel.appendChild(pats);

    const prev = document.createElement('div');
    prev.className = 'patterns';
    for (const pv of PREVIEW) {
      const b = document.createElement('div');
      b.className = 'btn';
      b.textContent = pv.label;
      b.addEventListener('click', () => this.onPreview(pv.slot));
      prev.appendChild(b);
      this.previewBtns.push(b);
    }
    this.panel.appendChild(prev);

    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = 'Изменения применяются мгновенно и сохраняются автоматически.';
    this.panel.appendChild(note);

    const close = document.createElement('div');
    close.className = 'btn magenta';
    close.textContent = 'ВКАТИТЬСЯ ОБРАТНО (ESC / ПРОБЕЛ)';
    close.addEventListener('click', () => this.onClose());
    this.panel.appendChild(close);

    this.selectTab('player');
  }

  private sectTitle(text: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'sect-title';
    d.textContent = text;
    return d;
  }

  private set(patch: Partial<{ primary: number; secondary: number; pattern: number }>): void {
    this.cfg.set(this.tab, patch);
  }

  selectTab(t: CustomTarget): void {
    this.tab = t;
    for (const [k, el] of this.tabBtns) el.classList.toggle('on', k === t);
    this.refresh();
  }

  /** Перерисовка кнопок и превью узоров под текущую вкладку */
  refresh(): void {
    const c = this.cfg.get(this.tab);
    this.primarySw.forEach((s, i) => s.classList.toggle('on', i === c.primary));
    this.secondarySw.forEach((s, i) => s.classList.toggle('on', i === c.secondary));
    this.patternEls.forEach((p, i) => {
      p.classList.toggle('on', i === c.pattern);
      const old = p.querySelector('canvas');
      const cv = makePreviewCanvas(c.primary, c.secondary, i);
      cv.style.width = '56px';
      cv.style.height = '56px';
      cv.style.imageRendering = 'pixelated';
      if (old) old.replaceWith(cv);
      else p.insertBefore(cv, p.firstChild);
    });
  }

  isOpen(): boolean {
    return this.panel.classList.contains('on');
  }

  open(): void {
    this.panel.classList.add('on');
    this.refresh();
  }

  close(): void {
    this.panel.classList.remove('on');
  }
}
