import * as THREE from 'three';
import { ProjectileManager } from '../combat/ProjectileManager';
import { ClubVFX } from '../world/ClubVFX';
import { Collider } from '../world/Collider';
import { DamageInfo, Targetable, WeaponSlot } from '../types';
import { CameraController } from './CameraController';
import { PlayerModel } from './PlayerModel';
import { SkaterController } from './SkaterController';

const DEG = Math.PI / 180;
export const MAG_SIZE = 32;
const FIRE_RATE = 11;
const RELOAD_TIME = 1.05;
const DMG_GUN = 26;
const DMG_HEAD = 52;
const DMG_KNIFE = 160;
const KNIFE_CD = 0.26;
const KNIFE_RANGE = 4.6;
const KNIFE_HALF_ANGLE = 60 * DEG;
const DASH_RANGE = 6;
const AUTO_RANGE = 38;
const AUTO_CONE = 32 * DEG;
const AIM_RANGE = 110;
const NOAIM_RANGE = 60;

/** Хуки оружия: звук, хитмаркеры, события урона — реализуются в main.ts */
export interface WeaponHooks {
  onShot(): void;
  onHit(t: Targetable, info: DamageInfo, killed: boolean): void;
  onEmpty(): void;
  onReloadStart(): void;
  onReloadDone(): void;
  onKnifeSwing(): void;
  onKnifeHit(count: number): void;
  onFlex(grindOrRamp: boolean): void;
  onSlot(slot: WeaponSlot): void;
}

export interface WeaponInput {
  fireHeld: boolean;
  firePressed: boolean;
  aimHeld: boolean;
  reloadPressed: boolean;
  /** Игрок в грайнде или в полёте (для синхро-киллов и стиля перчаток) */
  inTrick: boolean;
  /** Игрок в грайнде или в полёте после рампы (стиль перчаток) */
  grindOrRamp: boolean;
  dt: number;
}

export interface WeaponDeps {
  camera: CameraController;
  model: PlayerModel;
  skater: SkaterController;
  col: Collider;
  vfx: ClubVFX;
  shots: ProjectileManager;
  targets: () => Targetable[];
  hooks: WeaponHooks;
}

/**
 * WeaponSystem: три слота экипировки, стрельба (автонаводка без ПКМ, точный луч с ПКМ),
 * перезарядка R, кручение/удар ножа-бабочки, стиль перчаток.
 */
export class WeaponSystem {
  slot: WeaponSlot = 1;
  ammo = MAG_SIZE;
  /** Цель автонаводки (для ромба захвата в HUD); null — цели нет */
  autoTarget: Targetable | null = null;
  /** Точка прицела при ПКМ (для HUD крестика) — null, если луч ни во что не попал */
  aimHit: Targetable | null = null;
  private fireCd = 0;
  private knifeCd = 0;
  private reloadLeft = 0;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();

  constructor(private readonly d: WeaponDeps) {}

  isReloading(): boolean {
    return this.reloadLeft > 0;
  }

  setSlot(slot: WeaponSlot): void {
    if (slot === this.slot) return;
    this.slot = slot;
    this.reloadLeft = 0;
    this.d.model.setSlot(slot);
    this.d.hooks.onSlot(slot);
  }

  /** Колесо мыши: 1 → 2 → 3 → 1 */
  cycleSlot(dir: number): void {
    const order: WeaponSlot[] = [1, 2, 3];
    const i = order.indexOf(this.slot);
    const next = order[(i + dir + 3) % 3];
    this.setSlot(next);
  }

  private startReload(): void {
    if (this.reloadLeft > 0 || this.ammo === MAG_SIZE) return;
    this.reloadLeft = RELOAD_TIME;
    this.d.model.playReload();
    this.d.hooks.onReloadStart();
  }

  update(inp: WeaponInput): void {
    const { dt } = inp;
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.knifeCd = Math.max(0, this.knifeCd - dt);
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) {
        this.reloadLeft = 0;
        this.ammo = MAG_SIZE;
        this.d.hooks.onReloadDone();
      }
    }
    if (inp.reloadPressed && this.slot === 1) this.startReload();

    // Автонаводка и цель прицела пересчитываются каждый кадр для HUD
    this.autoTarget = this.slot === 1 && !inp.aimHeld ? this.findAuto() : null;
    this.aimHit = null;

    if (this.slot === 1) {
      if (inp.fireHeld && this.fireCd <= 0) {
        if (this.ammo <= 0) {
          this.d.hooks.onEmpty();
          this.startReload();
          this.fireCd = 0.2;
        } else {
          this.fireGun(inp.aimHeld, inp.inTrick);
          this.fireCd = 1 / FIRE_RATE;
        }
      }
    } else if (inp.firePressed) {
      if (this.slot === 2 && this.knifeCd <= 0) this.knifeSlash(inp.inTrick);
      if (this.slot === 3) {
        this.d.model.playFlex();
        this.d.hooks.onFlex(inp.grindOrRamp);
      }
    }
  }

  /** Лучший живой враг в конусе автонаводки, не закрытый стеной */
  private findAuto(): Targetable | null {
    const cam = this.d.camera.camera;
    const origin = cam.position;
    const fwd = this.d.camera.forward(this.tmpA);
    let best: Targetable | null = null;
    let bestAng = AUTO_CONE;
    for (const t of this.d.targets()) {
      const c = t.getCenter(this.tmpB);
      const v = c.clone().sub(origin);
      const dist = v.length();
      if (dist > AUTO_RANGE || dist < 1e-3) continue;
      const ang = Math.acos(THREE.MathUtils.clamp(v.dot(fwd) / dist, -1, 1));
      if (ang > bestAng) continue;
      if (!this.d.col.lineClear(origin, c)) continue;
      bestAng = ang;
      best = t;
    }
    return best;
  }

  /** Луч из камеры до первой живой цели (с учётом сферы радиуса цели) */
  private rayTargets(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { t: Targetable; point: THREE.Vector3; dist: number } | null {
    let best: { t: Targetable; point: THREE.Vector3; dist: number } | null = null;
    for (const t of this.d.targets()) {
      const c = t.getCenter(this.tmpC);
      const oc = c.clone().sub(origin);
      const tp = oc.dot(dir);
      if (tp < 0 || tp > maxDist) continue;
      const perp2 = oc.lengthSq() - tp * tp;
      const r2 = t.radius * t.radius;
      if (perp2 > r2) continue;
      const entry = tp - Math.sqrt(r2 - perp2);
      if (!best || entry < best.dist) {
        best = { t, dist: entry, point: origin.clone().addScaledVector(dir, entry) };
      }
    }
    return best;
  }

  private fireGun(aimHeld: boolean, inTrick: boolean): void {
    const d = this.d;
    const cam = d.camera.camera;
    const origin = cam.position.clone();
    const camDir = d.camera.forward(new THREE.Vector3());
    const muzzle = d.model.muzzleWorld(new THREE.Vector3());
    const wallDist = d.col.raycast(origin, camDir, aimHeld ? AIM_RANGE : NOAIM_RANGE);

    let endPoint: THREE.Vector3;
    let hitT: Targetable | null = null;
    let hitPoint: THREE.Vector3 | null = null;
    let headshot = false;

    if (aimHeld) {
      // Точный прицел: луч из центра экрана до 110 м
      const hit = this.rayTargets(origin, camDir, Math.min(AIM_RANGE, wallDist));
      if (hit) {
        hitT = hit.t;
        hitPoint = hit.point;
        headshot = hit.t.isWeakPoint(hit.point);
      }
      this.aimHit = hitT;
      endPoint = hitPoint ?? origin.clone().addScaledVector(camDir, Math.min(AIM_RANGE, wallDist));
    } else if (this.autoTarget) {
      // Автонаводка: пули летят в грудь захваченной цели (если стена не мешает)
      const c = this.autoTarget.getCenter(new THREE.Vector3());
      if (d.col.lineClear(muzzle, c)) {
        hitT = this.autoTarget;
        hitPoint = c;
      }
      endPoint = hitPoint ?? c;
    } else {
      // Без цели — по взгляду камеры, ближний контакт в пределах 60 м
      const hit = this.rayTargets(origin, camDir, Math.min(NOAIM_RANGE, wallDist));
      if (hit) {
        hitT = hit.t;
        hitPoint = hit.point;
      }
      endPoint = hitPoint ?? origin.clone().addScaledVector(camDir, Math.min(NOAIM_RANGE, wallDist));
    }

    this.ammo--;
    d.hooks.onShot();
    d.model.recoil();
    d.shots.tracer(muzzle, endPoint);
    d.shots.muzzleFlash(muzzle, camDir);
    const right = d.skater.right(new THREE.Vector3());
    d.shots.casing(muzzle.clone(), right);
    d.model.aimAt(this.aimYawLocal(camDir), this.aimPitchLocal(camDir));

    if (hitT && hitPoint) {
      const info: DamageInfo = {
        amount: headshot ? DMG_HEAD : DMG_GUN,
        method: 'gun',
        headshot,
        fromTrick: inTrick,
        point: hitPoint,
      };
      d.vfx.burst(hitPoint, 0xffe84a, 6, 6, 0.25, 0.08, 10);
      const killed = hitT.damage(info);
      d.hooks.onHit(hitT, info, killed);
    }
    if (this.ammo <= 0) this.startReload();
  }

  /** Аимовый угол влево-вправо в локальных осях скейтера (для поворота торса) */
  private aimYawLocal(camDir: THREE.Vector3): number {
    const f = this.d.skater.forward(new THREE.Vector3());
    const r = this.d.skater.right(new THREE.Vector3());
    const dx = camDir.dot(r);
    const dz = camDir.dot(f);
    return -Math.atan2(dx, Math.max(0.01, dz));
  }

  private aimPitchLocal(camDir: THREE.Vector3): number {
    return Math.asin(THREE.MathUtils.clamp(camDir.y, -1, 1));
  }

  /** Удар ножом: цели в конусе 120° и радиусе 4.6 м; рывок к ближайшей цели в радиусе 6 м */
  private knifeSlash(inTrick: boolean): void {
    const d = this.d;
    this.knifeCd = KNIFE_CD;
    d.model.playSlash();
    d.hooks.onKnifeSwing();
    const fwd = d.skater.forward(new THREE.Vector3());
    const pos = d.skater.pos;
    d.shots.slashArc(pos.clone(), Math.atan2(-fwd.x, -fwd.z));
    let hits = 0;
    let dash: THREE.Vector3 | null = null;
    let dashDist = Infinity;
    const cosHalf = Math.cos(KNIFE_HALF_ANGLE);
    for (const t of d.targets()) {
      const c = t.getCenter(this.tmpA);
      const v = c.clone().sub(pos);
      v.y = 0;
      const dist = v.length();
      if (dist < 1e-3) continue;
      const cos = v.dot(fwd) / dist;
      if (cos < cosHalf) continue;
      // Магнитный рывок: ближайшая цель впереди в радиусе 6 м
      if (dist <= DASH_RANGE && dist < dashDist) {
        dashDist = dist;
        dash = v.clone().normalize();
      }
      if (dist <= KNIFE_RANGE + t.radius) {
        const info: DamageInfo = { amount: DMG_KNIFE, method: 'knife', headshot: false, fromTrick: inTrick, point: c };
        const killed = t.damage(info);
        hits++;
        d.vfx.burst(c, 0xffffff, 14, 9, 0.35, 0.12, 6);
        d.hooks.onHit(t, info, killed);
      }
    }
    if (dash && hits === 0) d.skater.dash(dash);
    if (hits > 0) d.hooks.onKnifeHit(hits);
  }

  /** Обнуление состояния при рестарте уровня */
  reset(): void {
    this.ammo = MAG_SIZE;
    this.reloadLeft = 0;
    this.fireCd = 0;
    this.knifeCd = 0;
    this.autoTarget = null;
    this.aimHit = null;
    this.d.model.setSlot(this.slot);
  }
}
