import { RankThresholds } from '../types';

/** Тон всплывающей надписи (соответствует классам .callout.* в CSS) */
export type CalloutTone = 'trick' | 'kill' | 'sync' | 'rank';

export const MAX_MULT = 99;
export const MAX_HP = 100;
const TIMER_MAX = 4.0;

/** Мемы из §6.3 */
export const TRICK_CALLOUTS = ['СЛАВЯНСКИЙ КИКФЛИП!', 'РАЗДАЛ БАЗЫ НА ПЕРИЛАХ!', 'УЛЁТ В ГИПЕРБОРЕЮ!', 'ЧЁТКИЙ ГРЭБ!', 'ФИЗИКА ВЫШЛА ИЗ ЧАТА!'];
export const GUN_CALLOUTS = ['МИНУС РЕПТИЛОИД!', 'ЧЕШУЯ В РЕШЕТО!', 'ЖЕСТЯНКА В ЧЕРМЕТ!', 'ДОМОЙ НА НИБИРУ!'];
export const HEADSHOT_CALLOUT = 'В ЖБАН (ХЭДШОТ)!';
export const KNIFE_CALLOUTS = ['НОЖЕВАЯ ГОЙДА!', 'НАРЕЗКА ЯЩЕРОВ!', 'ШАШЛЫК ИЗ РЕПТИЛИИ!', 'БАБОЧКА ПОРХАЕТ — ЯЩЕР ОТЛЕТАЕТ!'];
export const SYNC_CALLOUTS = ['СИНХРО-РАЗНОС!', 'КИБЕР-СЛОНЯРА В ПОТОКЕ!', 'УЛЬТРА-УГАР 1999!', 'ЗА БАЙКАЛЬСКИЙ РЕЙВ!'];
export const FLEX_CALLOUTS = ['ФЛЕКС ПЕРЧАТКАМИ!', 'КОЗА НА ВСЮ КАТУШКУ!', 'ЭТО ПЕРЧАТКИ, БРАТ!'];
export const ACID_CALLOUT = 'АЙ, ЖЖЁТСЯ КРИНЖ!';

export const RANK_TEXT: Record<string, string> = {
  D: 'ПОПУЩЕН НА ФЕЙС-КОНТРОЛЕ',
  C: 'ПОДПИВАС НА САМОКАТЕ',
  B: 'БОДРЫЙ РЕЙВЕР',
  A: 'МАСТЕР БАЛИСОНГА',
  S: 'ЛЕГЕНДА ГИПЕРБОРЕИ / ГРОЗА ЯЩЕРОВ',
};

export const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** Ранг по порогам уровня */
export function rankFor(score: number, t: RankThresholds): 'S' | 'A' | 'B' | 'C' | 'D' {
  if (score >= t.S) return 'S';
  if (score >= t.A) return 'A';
  if (score >= t.B) return 'B';
  if (score >= t.C) return 'C';
  return 'D';
}

/**
 * ComboSystem: очки, множитель x1..x99, таймер «ВАЙБ» 4.0 с, HP и мемные надписи (Hotline Miami).
 * Очки начисляются как base × множитель; при истечении таймера множитель сбрасывается, очки остаются.
 */
export class ComboSystem {
  score = 0;
  mult = 1;
  timer = 0;
  hp = MAX_HP;
  /** Счётчик олли без киллов/рельсов — для анти-абуза таймера */
  private spamOllies = 0;
  /** Сколько раз стиль-бонус перчаток уже выдан за текущий прыжок */
  private flexUsed = false;
  /** Идёт ли грайнд: таймер заморожен на 100% */
  frozen = false;
  onCallout: ((text: string, tone: CalloutTone) => void) | null = null;
  onMultChange: ((mult: number) => void) | null = null;
  onHeal: ((amount: number) => void) | null = null;

  reset(): void {
    this.score = 0;
    this.mult = 1;
    this.timer = 0;
    this.hp = MAX_HP;
    this.spamOllies = 0;
    this.flexUsed = false;
    this.frozen = false;
  }

  /** Таймер комбо: убывает на 1 с/с, при нуле множитель сбрасывается до x1 */
  tick(dt: number): void {
    if (this.mult <= 1 && this.timer <= 0) return;
    if (!this.frozen) this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0;
      if (this.mult !== 1) {
        this.mult = 1;
        this.onMultChange?.(this.mult);
      }
    }
  }

  /** Сброс «стиль-бонуса за прыжок» при приземлении */
  landed(): void {
    this.flexUsed = false;
  }

  private add(base: number): number {
    const v = Math.round(base * this.mult);
    this.score += v;
    return v;
  }

  private bumpMult(n: number): void {
    this.mult = Math.min(MAX_MULT, this.mult + n);
    this.onMultChange?.(this.mult);
  }

  private extendTimer(sec: number): void {
    this.timer = Math.min(TIMER_MAX, Math.max(this.timer, 0) + sec);
    if (this.timer <= 0) this.timer = sec;
  }

  /** Олли + флип: +150×множитель, таймер +1.2 с (анти-абуз: 0.2 с при спаме без киллов) */
  ollieFlip(name: string): void {
    this.add(150);
    this.spamOllies++;
    this.extendTimer(this.spamOllies <= 3 ? 1.2 : 0.2);
    this.onCallout?.(name, 'trick');
  }

  /** Новые перила или вылет с рампы: +300×множитель, +1 к множителю */
  railOrRamp(text: string): void {
    this.add(300);
    this.bumpMult(1);
    this.spamOllies = 0;
    this.extendTimer(TIMER_MAX);
    this.onCallout?.(text, 'trick');
  }

  /** Проход на перилах без смены перил не продлевает таймер, но не сбрасывает комбо */
  grindPoints(points: number): void {
    this.add(points);
  }

  /** Убийство из пушки: +500×множитель, +1 множитель, таймер полный; хэдшот +250×множитель */
  gunKill(headshot: boolean, name: string): void {
    this.add(500);
    this.bumpMult(1);
    this.spamOllies = 0;
    this.timer = TIMER_MAX;
    if (headshot) {
      this.add(250);
      this.onCallout?.('В ЖБАН (ХЭДШОТ)!', 'kill');
    } else {
      this.onCallout?.(name, 'kill');
    }
    if (this.mult >= 6) this.heal(8);
  }

  /** Убийство ножом: +1250×множитель, +2 множитель, таймер полный, +25 HP */
  knifeKill(name: string): void {
    this.add(1250);
    this.bumpMult(2);
    this.spamOllies = 0;
    this.timer = TIMER_MAX;
    this.heal(25);
    this.onCallout?.(name, 'kill');
  }

  /** Синхро-килл: +2000×множитель (+3000 с перил/в прыжке для ножа), +3 к множителю */
  synchro(knife: boolean, railOrAir: boolean): void {
    this.add(knife && railOrAir ? 3000 : 2000);
    this.bumpMult(3);
    this.timer = TIMER_MAX;
    this.spamOllies = 0;
    this.onCallout?.(pick(SYNC_CALLOUTS), 'sync');
  }

  /** Стиль перчаток: +50×множитель один раз за прыжок (только в грайнде или в полёте с рампы) */
  flex(inGrindOrRamp: boolean): boolean {
    if (!inGrindOrRamp || this.flexUsed) {
      this.onCallout?.(pick(FLEX_CALLOUTS), 'trick');
      return false;
    }
    this.flexUsed = true;
    this.add(50);
    this.onCallout?.(pick(FLEX_CALLOUTS), 'trick');
    return true;
  }

  heal(n: number): void {
    const before = this.hp;
    this.hp = Math.min(MAX_HP, this.hp + n);
    if (this.hp > before) this.onHeal?.(this.hp - before);
  }

  /** Получение урона; возвращает true, если HP упало до нуля */
  hurt(n: number): boolean {
    this.hp = Math.max(0, this.hp - n);
    return this.hp <= 0;
  }
}
