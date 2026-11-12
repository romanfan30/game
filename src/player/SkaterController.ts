import * as THREE from 'three';
import { Collider, Surface } from '../world/Collider';
import { TrickObjects, TrickRail } from '../world/TrickObjects';
import { GrindStyle, GROUND_FLIPS, VERT_TRICKS } from '../types';

/** Параметры движения (раздел 4.1) */
const ACCEL = 38;
const CRUISE = 24;
const BOOST_MAX = 32;
const BRAKE = 45;
const REVERSE_MAX = -8;
const TURN_RATE = 2.6;
const ASSIST = 0.7;
const LATERAL_GRIP = 14;
const GRAVITY = 26;
const STEP_UP = 0.9;
const RADIUS = 0.42;
const GRIND_STYLES: GrindStyle[] = ['50-50', 'boardslide', 'nosegrind', 'slavslide'];

export interface SkaterInput {
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  space: boolean;
  camYaw: number;
}

/** События трюков/физики, на которые подписан Game (счёт, звук, частицы) */
export interface SkaterEvents {
  onOllie?: () => void;
  onFlip?: (name: string) => void;
  onAirTrick?: (name: string) => void;
  onGrindStart?: (rail: TrickRail, style: GrindStyle, isNew: boolean) => void;
  onGrindEnd?: (kind: 'end' | 'jump') => void;
  onGrindTick?: () => void;
  onGrindSpark?: (p: THREE.Vector3) => void;
  onBrakeSpark?: (p: THREE.Vector3) => void;
  onRampLaunch?: (name: string, ramp: Surface) => void;
  onVertLand?: (name: string) => void;
  onLand?: (impact: number) => void;
  onAcid?: (p: THREE.Vector3) => void;
}

interface GrindState {
  rail: TrickRail;
  s: number;
  dir: 1 | -1;
  style: GrindStyle;
  v: number;
  t: number;
  tick: number;
  spark: number;
  magFrom: THREE.Vector3;
  isNew: boolean;
}

interface FlipState {
  t: number;
  dur: number;
  amt: THREE.Vector3;
}

const TWO_PI = Math.PI * 2;

/** Угол курса h, при котором forward F(h) = (-sin h, 0, -cos h) совпадает с (x, z) */
function headingOf(x: number, z: number): number {
  return Math.atan2(-x, -z);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Амплитуды вращения доски для наземных флипов (ось X — pitch, Y — yaw, Z — roll) */
function groundFlipAmount(name: string): THREE.Vector3 {
  switch (name) {
    case 'КИКФЛИП':
      return new THREE.Vector3(0, 0, TWO_PI);
    case 'ХИЛФЛИП':
      return new THREE.Vector3(0, 0, -TWO_PI);
    case '360 ПОП-ШАВИТ':
      return new THREE.Vector3(0, TWO_PI, TWO_PI);
    case 'ИМПОССИБЛ':
      return new THREE.Vector3(TWO_PI, 0, 0);
    default:
      return new THREE.Vector3(TWO_PI, 0, -TWO_PI);
  }
}

/**
 * SkaterController: кинематическая аркадная физика скейта + контекстный SPACE.
 * Игрок всегда на скейте; скорость не зависит от оружия.
 */
export class SkaterController {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  heading = 0;
  grounded = false;
  surface: Surface | null = null;
  grind: GrindState | null = null;
  /** Вращение деки (трюки на земле и в воздухе) */
  readonly boardSpin = new THREE.Vector3();
  /** Вращение всего тела (вертушки с рамп, двойной флип) */
  readonly bodySpin = new THREE.Vector3();
  events: SkaterEvents = {};
  /** Заморозка для Гримёрки: тормозит до нуля и игнорирует ввод */
  frozen = false;
  lean = 0;
  pushing = false;
  steering = 0;
  airTrickUsed = false;
  lastRailId = -1;
  private lastRailEnd = -100;
  private railCooldownId = -1;
  private railCooldownEnd = -100;
  private flip: FlipState | null = null;
  private vert: { t: number; dur: number; spin: number; name: string } | null = null;
  private airFlip: { t: number } | null = null;
  private dashT = 0;
  private readonly dashDir = new THREE.Vector3();
  private acidCd = 0;
  private brakeSparkCd = 0;
  private col: Collider | null = null;
  private tricks: TrickObjects | null = null;
  private time = 0;
  private readonly tmp = new THREE.Vector3();

  setWorld(col: Collider, tricks: TrickObjects | null): void {
    this.col = col;
    this.tricks = tricks;
  }

  /** Курсовой единичный вектор вперёд (горизонтальный) */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  /** Вправо от скейтера */
  right(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
  }

  speedFwd(): number {
    const f = this.forward(this.tmp);
    return this.vel.x * f.x + this.vel.z * f.z;
  }

  horizontalSpeed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** Игрок в процессе трюка (грайнд, флип или вертушка в воздухе) — для синхро-киллов */
  inTrick(): boolean {
    return this.grind !== null || !this.grounded;
  }

  reset(pos: THREE.Vector3, heading: number): void {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.grounded = false;
    this.surface = null;
    this.grind = null;
    this.flip = null;
    this.vert = null;
    this.airFlip = null;
    this.boardSpin.set(0, 0, 0);
    this.bodySpin.set(0, 0, 0);
    this.airTrickUsed = false;
    this.lastRailId = -1;
    this.railCooldownId = -1;
    this.dashT = 0;
    this.frozen = false;
  }

  /** Мягкий толчок в сторону цели (магнитный бросок ножа) */
  dash(dir: THREE.Vector3): void {
    if (this.dashT > 0) return;
    this.dashDir.set(dir.x, 0, dir.z).normalize();
    this.dashT = 0.1;
  }

  /** Главный апдейт: ввод → трюки → физика → визуальные вращения */
  update(dt: number, input: SkaterInput, time: number): void {
    if (!this.col) return;
    this.time = time;
    this.acidCd = Math.max(0, this.acidCd - dt);
    this.brakeSparkCd = Math.max(0, this.brakeSparkCd - dt);
    if (this.frozen) {
      input = { fwd: false, back: false, left: false, right: false, space: false, camYaw: input.camYaw };
    } else if (input.space) {
      this.handleSpace(time);
    }
    if (this.grind) this.updateGrind(dt, input);
    else this.updatePhysics(dt, input);
    this.updateTrickRotations(dt);
  }

  /** Контекстный SPACE: рельс → рампа → олли → доп. трюк в воздухе (раздел 4.2) */
  private handleSpace(time: number): void {
    if (this.grind) {
      const kind: 'jump' = 'jump';
      this.endGrind(kind);
      this.vel.y = 11.0;
      this.grounded = false;
      this.surface = null;
      this.startGroundFlip('360 ПОП-ШАВИТ');
      return;
    }
    if (this.tricks) {
      const f = this.tricks.findRail(this.pos, 2.5);
      if (f && !(f.rail.id === this.railCooldownId && time - this.railCooldownEnd < 0.2)) {
        this.startGrind(f.rail, f.s);
        return;
      }
    }
    const ramp = this.findRampTrigger();
    if (ramp) {
      this.launchRamp(ramp);
      return;
    }
    if (this.grounded) {
      this.ollie();
      return;
    }
    if (!this.airTrickUsed) this.airDouble();
  }

  private findRampTrigger(): Surface | null {
    if (this.grounded && this.surface && (this.surface.kind === 'ramp' || this.surface.kind === 'mega')) return this.surface;
    if (!this.tricks) return null;
    for (const r of this.tricks.ramps) {
      if (!r.enabled || (r.kind !== 'ramp' && r.kind !== 'mega')) continue;
      const sh = r.shape as { u1: number };
      const q = this.pos.clone();
      q.y = r.origin.y + r.slope * sh.u1;
      if (r.topEdgeDistance(q) <= 1.5) return r;
    }
    return null;
  }

  private ollie(): void {
    this.vel.y = 10.2;
    this.pos.y += 0.02;
    this.grounded = false;
    this.surface = null;
    this.airTrickUsed = false;
    const name = GROUND_FLIPS[Math.floor(Math.random() * GROUND_FLIPS.length)];
    this.flip = { t: 0, dur: 0.45, amt: groundFlipAmount(name) };
    this.events.onOllie?.();
    this.events.onFlip?.(name);
  }

  private startGroundFlip(name: string): void {
    this.flip = { t: 0, dur: 0.45, amt: groundFlipAmount(name) };
  }

  private airDouble(): void {
    this.vel.y = Math.max(this.vel.y + 2.5, 4.0);
    this.airTrickUsed = true;
    this.airFlip = { t: 0 };
    this.events.onAirTrick?.('ДАБЛ-ЭЙР ФЛИП');
  }

  private launchRamp(ramp: Surface): void {
    const up = ramp.uphill();
    this.vel.y = 15.5;
    this.vel.x += up.x * 6;
    this.vel.z += up.z * 6;
    this.grounded = false;
    this.surface = null;
    this.pos.y += 0.05;
    const name = VERT_TRICKS[Math.floor(Math.random() * VERT_TRICKS.length)];
    const spin = name.includes('720') ? TWO_PI * 2 : TWO_PI;
    this.vert = { t: 0, dur: (2 * 15.5) / GRAVITY, spin, name };
    this.events.onRampLaunch?.(name, ramp);
  }

  private startGrind(rail: TrickRail, s: number): void {
    const tan = rail.tangentAt(s);
    const f = this.forward(this.tmp);
    const dot = tan.x * f.x + tan.z * f.z;
    const dir: 1 | -1 = dot >= 0 ? 1 : -1;
    const style = GRIND_STYLES[Math.floor(Math.random() * GRIND_STYLES.length)];
    const isNew = rail.id !== this.lastRailId || this.time - this.lastRailEnd > 3;
    this.grind = {
      rail,
      s,
      dir,
      style,
      v: Math.max(23, this.horizontalSpeed()),
      t: 0,
      tick: 0,
      spark: 0,
      magFrom: this.pos.clone(),
      isNew,
    };
    this.grounded = false;
    this.surface = null;
    this.flip = null;
    this.boardSpin.set(0, 0, 0);
    this.events.onGrindStart?.(rail, style, isNew);
  }

  private endGrind(kind: 'end' | 'jump'): void {
    const g = this.grind;
    if (!g) return;
    this.railCooldownId = g.rail.id;
    this.railCooldownEnd = this.time;
    this.lastRailId = g.rail.id;
    this.lastRailEnd = this.time;
    this.grind = null;
    this.events.onGrindEnd?.(kind);
  }

  private updateGrind(dt: number, inp: SkaterInput): void {
    const g = this.grind!;
    g.t += dt;
    g.v += (25 - g.v) * Math.min(1, dt * 0.6);
    if (inp.fwd) g.v = Math.min(32, g.v + 6 * dt);
    g.s += g.dir * g.v * dt;
    const L = g.rail.length;
    if (g.rail.closed) {
      g.s = ((g.s % L) + L) % L;
    } else if (g.s <= 0 || g.s >= L) {
      // Конец перил: выброс вперёд с сохранением скорости
      const endS = THREE.MathUtils.clamp(g.s, 0, L);
      const p = g.rail.pointAt(endS);
      const tan = g.rail.tangentAt(endS).multiplyScalar(g.dir);
      this.pos.set(p.x, p.y + 0.12, p.z);
      this.vel.copy(tan).multiplyScalar(g.v);
      this.vel.y = 2.5;
      if (Math.hypot(tan.x, tan.z) > 0.01) this.heading = headingOf(tan.x, tan.z);
      this.endGrind('end');
      return;
    }
    const p = g.rail.pointAt(g.s);
    const target = new THREE.Vector3(p.x, p.y + 0.12, p.z);
    if (g.t < 0.12) this.pos.lerpVectors(g.magFrom, target, g.t / 0.12);
    else this.pos.copy(target);
    const tan = g.rail.tangentAt(g.s).multiplyScalar(g.dir);
    if (Math.hypot(tan.x, tan.z) > 0.01) this.heading = headingOf(tan.x, tan.z);
    this.vel.copy(tan).multiplyScalar(g.v);
    this.grounded = false;
    this.surface = null;
    g.tick += dt;
    if (g.tick >= 0.15) {
      g.tick -= 0.15;
      this.events.onGrindTick?.();
    }
    g.spark -= dt;
    if (g.spark <= 0) {
      g.spark = 0.03;
      this.events.onGrindSpark?.(this.pos.clone());
    }
  }

  private updatePhysics(dt: number, inp: SkaterInput): void {
    const col = this.col!;
    // Карвинг и подруливание к взгляду камеры (35%) при езде вперёд
    this.steering = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);
    if (this.steering !== 0) this.heading += this.steering * TURN_RATE * dt;
    const s0 = this.speedFwd();
    if (this.steering === 0 && this.grounded && s0 > 2) {
      const diff = wrapAngle(inp.camYaw - this.heading);
      this.heading += diff * Math.min(1, ASSIST * dt * 2);
    }

    const F = this.forward(this.tmp);
    const R = this.right(new THREE.Vector3());
    let s = this.vel.x * F.x + this.vel.z * F.z;
    let lat = this.vel.x * R.x + this.vel.z * R.z;

    this.pushing = inp.fwd && this.grounded && s < 23;
    if (this.grounded) {
      if (this.frozen) {
        s -= Math.sign(s) * Math.min(Math.abs(s), 14 * dt);
      } else if (inp.fwd) {
        s += ACCEL * dt;
        if (s > BOOST_MAX) s = BOOST_MAX;
        else if (s > CRUISE) s = Math.max(CRUISE, s - 3 * dt);
      } else if (inp.back) {
        if (s > 0.5) {
          s = Math.max(0, s - BRAKE * dt);
          this.brakeSpark();
        } else {
          s = Math.max(REVERSE_MAX, s - BRAKE * dt);
        }
      } else {
        s -= Math.sign(s) * Math.min(Math.abs(s), 3.0 * dt);
      }
      lat *= Math.exp(-LATERAL_GRIP * dt);
    } else {
      lat *= Math.exp(-0.6 * dt);
    }

    if (this.dashT > 0) {
      this.dashT -= dt;
      this.vel.addScaledVector(this.dashDir, (6 / 0.1) * dt);
    }

    this.vel.x = F.x * s + R.x * lat;
    this.vel.z = F.z * s + R.z * lat;
    if (!this.grounded) this.vel.y -= GRAVITY * dt;
    else this.vel.y = 0;

    const prevY = this.pos.y;
    const prevVy = this.vel.y;
    const np = new THREE.Vector3(this.pos.x + this.vel.x * dt, prevY + this.vel.y * dt, this.pos.z + this.vel.z * dt);

    // Стены: скольжение вдоль стены и выталкивание
    const contact = col.resolveXZ(np, RADIUS, prevY);
    if (contact) {
      const vn = this.vel.dot(contact);
      if (vn > 0) this.vel.addScaledVector(contact, -vn);
    }

    // Поверхности: посадка, прилипание к склону, падение с края
    const wasGrounded = this.grounded;
    const hit = col.groundAt(np.x, np.z, prevY, STEP_UP);
    let landed = false;
    if (hit && np.y <= hit.height + 0.02 && this.vel.y <= 0.01) {
      landed = !wasGrounded;
      np.y = hit.height;
      this.grounded = true;
      this.surface = hit.surface;
      this.vel.y = 0;
    } else if (hit && wasGrounded && hit.height >= prevY - 0.6 && this.vel.y <= 0.01) {
      np.y = hit.height;
      this.grounded = true;
      this.surface = hit.surface;
      this.vel.y = 0;
    } else {
      this.grounded = false;
      this.surface = null;
    }

    this.pos.copy(np);
    this.lean = -this.steering * 0.22 * THREE.MathUtils.clamp(s / 20, 0, 1);

    if (landed) this.onLanded(-prevVy);
    if (this.grounded && this.surface?.kind === 'acid' && this.acidCd <= 0) this.acidBounce();
  }

  private onLanded(impact: number): void {
    this.airTrickUsed = false;
    if (this.vert) {
      const name = this.vert.name;
      this.vert = null;
      this.events.onVertLand?.(name);
    }
    this.airFlip = null;
    this.flip = null;
    this.events.onLand?.(impact);
  }

  /** Кислотная яма: урон (через событие), батут-подброс и выброс к краю */
  private acidBounce(): void {
    this.events.onAcid?.(this.pos.clone());
    const h = new THREE.Vector3(this.vel.x, 0, this.vel.z);
    const dir = h.lengthSq() > 0.01 ? h.normalize().multiplyScalar(-1) : this.forward(new THREE.Vector3()).multiplyScalar(-1);
    this.vel.y = 14;
    this.vel.x = dir.x * 10;
    this.vel.z = dir.z * 10;
    this.grounded = false;
    this.surface = null;
    this.acidCd = 0.6;
  }

  private brakeSpark(): void {
    if (this.brakeSparkCd > 0) return;
    this.brakeSparkCd = 0.05;
    this.events.onBrakeSpark?.(this.pos.clone());
  }

  /** Вращения флипов и вертушек (накладываются на визуальную модель) */
  private updateTrickRotations(dt: number): void {
    if (this.flip) {
      this.flip.t += dt;
      const k = Math.min(1, this.flip.t / this.flip.dur);
      this.boardSpin.copy(this.flip.amt).multiplyScalar(k);
      if (k >= 1) {
        this.flip = null;
        this.boardSpin.set(0, 0, 0);
      }
    } else if (this.grounded && !this.grind) {
      this.boardSpin.set(0, 0, 0);
    }

    let vertY = 0;
    if (this.vert) {
      this.vert.t += dt;
      vertY = this.vert.spin * Math.min(1, this.vert.t / this.vert.dur);
    }
    let airX = 0;
    if (this.airFlip) {
      this.airFlip.t += dt;
      const k = Math.min(1, this.airFlip.t / 0.5);
      airX = TWO_PI * k;
      if (k >= 1) this.airFlip = null;
    }
    this.bodySpin.set(airX, vertY, 0);
  }

  /** Тестовая точка: для HUD/эффектов — ближайший контакт с рельсом (если есть) */
  railSample(): THREE.Vector3 | null {
    return this.grind ? this.grind.rail.pointAt(this.grind.s) : null;
  }

  /** Есть ли активный грайнд (для заморозки таймера комбо) */
  isGrinding(): boolean {
    return this.grind !== null;
  }

  /** Текущее время контроллера (для пула трюков) */
  currentTime(): number {
    return this.time;
  }

  /** Внешний запрос на заморозку (сброс трюков при смерти и т.п.) */
  stopAllTricks(): void {
    this.grind = null;
    this.flip = null;
    this.vert = null;
    this.airFlip = null;
  }
}

export { STEP_UP, RADIUS, TWO_PI };
