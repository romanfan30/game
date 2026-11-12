/**
 * InputManager: клавиатура, мышь, PointerLock.
 * Коды клавиш — KeyboardEvent.code (не зависят от раскладки). Кнопки мыши: 'Mouse0' (ЛКМ), 'Mouse2' (ПКМ).
 */
export class InputManager {
  private down = new Set<string>();
  private pressed = new Set<string>();
  /** Накопленное за кадр смещение мыши при захваченном курсоре */
  mouseDX = 0;
  mouseDY = 0;
  /** Шаги колеса мыши за кадр (+1 вниз / -1 вверх) */
  wheel = 0;
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  onAnyPress: (() => void) | null = null;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!e.repeat) {
        this.pressed.add(e.code);
        this.onAnyPress?.();
      }
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });
    window.addEventListener('mousedown', (e) => {
      const code = `Mouse${e.button}`;
      this.down.add(code);
      this.pressed.add(code);
      this.onAnyPress?.();
    });
    window.addEventListener('mouseup', (e) => {
      this.down.delete(`Mouse${e.button}`);
    });
    window.addEventListener('blur', () => this.down.clear());
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (this.locked) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    window.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY);
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      this.onLockChange?.(this.locked);
    });
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** Истина в кадре, в котором клавиша была нажата */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Сбрасывает одноразовые события текущего кадра */
  endFrame(): void {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }

  requestLock(): void {
    if (document.pointerLockElement === this.target) return;
    const p = this.target.requestPointerLock() as unknown;
    if (p && typeof (p as Promise<void>).catch === 'function') {
      (p as Promise<void>).catch(() => {
        /* пользователь может отказать; игра продолжит работать без захвата */
      });
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }
}
