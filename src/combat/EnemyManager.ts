import * as THREE from 'three';
import { AudioGabber } from '../core/AudioGabber';
import { SkaterController } from '../player/SkaterController';
import { ClubVFX } from '../world/ClubVFX';
import { Collider } from '../world/Collider';
import { DamageInfo, EnemyType, Targetable } from '../types';
import { ProjectileManager } from './ProjectileManager';
import { Rig } from '../enemies/EnemyModels';

/** Контекст, который враги используют каждый кадр (без циклических импортов) */
export interface EnemyEnv {
  time: number;
  scene: THREE.Scene;
  player: SkaterController;
  col: Collider;
  vfx: ClubVFX;
  audio: AudioGabber;
  shots: ProjectileManager;
  /** Нанести урон игроку (с учётом источника для HUD) */
  hurtPlayer(amount: number, reason: string): void;
  /** Высота пола в точке (для ног врагов) */
  floorAt(x: number, z: number, ref: number): number;
  /** Взрыв в точке: урон всем врагам в радиусе, кроме source */
  explode(center: THREE.Vector3, radius: number, damage: number, source: Enemy | null): void;
}

let nextEnemyId = 1;

/** Базовый враг: здоровье, скелет, вспышка при попадании и общая логика смерти */
export abstract class Enemy implements Targetable {
  readonly id = nextEnemyId++;
  abstract readonly type: EnemyType;
  /** Цвет брызг при смерти */
  abstract readonly deathColor: number;
  /** Высота «груди» относительно корня */
  abstract readonly centerY: number;
  readonly radius = 0.6;
  alive = true;
  /** Анимация падения после смерти (время с момента смерти) */
  deadT = -1;
  flash = 0;
  /** Выставляется, когда враг закончил существование (например, подрыв дрона) — менеджер удаляет его */
  expired = false;
  readonly group = new THREE.Group();
  hp: number;
  readonly maxHp: number;
  rig: Rig;

  constructor(pos: THREE.Vector3, hp: number, rig: Rig) {
    this.hp = hp;
    this.maxHp = hp;
    this.rig = rig;
    this.group.position.copy(pos);
    this.group.add(rig.root);
  }

  /** Поведение за кадр; реализуется в каждом классе врага */
  abstract update(dt: number, env: EnemyEnv): void;

  /** Событие смерти (взрыв, спецэффекты) — переопределяется врагами, которым это нужно */
  onDeath(env: EnemyEnv): void {
    env.vfx.burst(this.group.position.clone().add(new THREE.Vector3(0, this.centerY, 0)), this.deathColor, 40, 9, 0.8, 0.14, 16);
  }

  getCenter(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.group.position.x, this.group.position.y + this.centerY, this.group.position.z);
  }

  isWeakPoint(p: THREE.Vector3): boolean {
    return p.y > this.group.position.y + this.centerY + 0.35;
  }

  damage(info: DamageInfo): boolean {
    if (!this.alive) return false;
    this.hp -= info.amount;
    this.flash = 0.12;
    if (this.hp <= 0) {
      this.alive = false;
      this.deadT = 0;
      return true;
    }
    return false;
  }

  /** Поворот корпуса к точке (только по Y) */
  faceTo(tx: number, tz: number, dt: number, rate = 8): void {
    const dx = tx - this.group.position.x;
    const dz = tz - this.group.position.z;
    const target = Math.atan2(-dx, -dz);
    let d = target - this.group.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.group.rotation.y += d * Math.min(1, dt * rate);
  }

  /** Горизонтальная ходьба по коллайдеру: стены и высота пола */
  moveXZ(vx: number, vz: number, dt: number, env: EnemyEnv): void {
    const p = new THREE.Vector3(this.group.position.x + vx * dt, this.group.position.y, this.group.position.z + vz * dt);
    env.col.resolveXZ(p, 0.5, this.group.position.y);
    this.group.position.x = p.x;
    this.group.position.z = p.z;
    const h = env.floorAt(p.x, p.z, this.group.position.y);
    this.group.position.y += (h - this.group.position.y) * Math.min(1, dt * 12);
  }

  /** Освобождение ресурсов сцены (побочные меши, кольца и т.п.) */
  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
  }

  /** Общая анимация: вспышка и падение */
  tickDeath(dt: number): boolean {
    if (this.deadT < 0) return false;
    this.deadT += dt;
    this.group.rotation.x = Math.min(1.45, this.deadT * 6);
    this.group.position.y -= dt * 0.4;
    return this.deadT > 0.7;
  }
}

/**
 * EnemyManager: список врагов, урон, смерть, взрывы в радиусе и убирание мёртвых из сцены.
 * Коллбэки onKill вызываются в момент смерти (очки и звук настраиваются в main.ts).
 */
export class EnemyManager {
  readonly enemies: Enemy[] = [];
  onKill: ((e: Enemy, info: DamageInfo) => void) | null = null;
  onExplosion: ((center: THREE.Vector3, radius: number) => void) | null = null;
  private readonly dead: Enemy[] = [];

  constructor(private readonly scene: THREE.Scene, private readonly env: () => EnemyEnv) {}

  add(e: Enemy, at?: THREE.Vector3): void {
    if (at) e.group.position.copy(at);
    this.scene.add(e.group);
    this.enemies.push(e);
  }

  /** Все живые цели (для автонаводки и хитсканов) */
  targets(): Targetable[] {
    return this.enemies.filter((e) => e.alive);
  }

  /** Урон врагу; при смерти вызывает onKill */
  damage(e: Enemy, info: DamageInfo): boolean {
    if (!e.alive) return false;
    const killed = e.damage(info);
    if (killed) this.kill(e, info);
    return killed;
  }

  private kill(e: Enemy, info: DamageInfo): void {
    e.onDeath(this.env());
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);
    this.dead.push(e);
    this.onKill?.(e, info);
  }

  /** Взрыв: урон всем врагам в радиусе (цепные взрывы дронов) */
  explode(center: THREE.Vector3, radius: number, damage: number, source: Enemy | null): void {
    this.onExplosion?.(center, radius);
    for (const e of [...this.enemies]) {
      if (e === source || !e.alive) continue;
      const c = e.getCenter(new THREE.Vector3());
      if (c.distanceTo(center) <= radius) {
        this.damage(e, { amount: damage, method: 'explosion', headshot: false, fromTrick: false, point: c });
      }
    }
  }

  update(dt: number, env: EnemyEnv): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.expired) {
        e.dispose(this.scene);
        this.enemies.splice(i, 1);
      }
    }
    for (const e of [...this.enemies]) {
      e.update(dt, env);
      e.flash = Math.max(0, e.flash - dt);
      // База свечения хранится у каждого материала: вспышка множит её, а не затирает
      for (const m of e.rig.glow) {
        const base = (m.userData.baseEmissive ??= m.emissiveIntensity) as number;
        m.emissiveIntensity = e.flash > 0 ? base * 3 : base;
      }
    }
    for (let i = this.dead.length - 1; i >= 0; i--) {
      const d = this.dead[i];
      if (d.tickDeath(dt)) {
        this.scene.remove(d.group);
        this.dead.splice(i, 1);
      }
    }
  }

  /** Очистка перед рестартом уровня */
  clear(): void {
    for (const e of this.enemies) e.dispose(this.scene);
    for (const e of this.dead) e.dispose(this.scene);
    this.enemies.length = 0;
    this.dead.length = 0;
  }
}
