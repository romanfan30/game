import * as THREE from 'three';
import { Collider } from '../world/Collider';
import { SkaterController } from './SkaterController';

const DEG = Math.PI / 180;
/** Смещения относительно скейтера (раздел 5.1): TPS и плечо */
const TPS_UP = 2.35;
const TPS_BACK = 4.8;
const SH_RIGHT = 0.88;
const SH_UP = 1.72;
const SH_BACK = 1.65;
/** Базовый угол возвышения TPS (atan(2.35/4.8)) */
const TPS_ELEV = Math.atan2(TPS_UP, TPS_BACK);

/**
 * CameraController: двухрежимная камера.
 * TPS (ПКМ отпущена) — FOV 78→90 от скорости; плечо (ПКМ зажата) — FOV 52, точный центральный прицел.
 * Орбита мышью: yaw без ограничений, pitch в [-35°, +55°]; пол/стены не пробиваются (рейкаст).
 */
export class CameraController {
  /** Смещение орбиты относительно курса скейтера (рад) */
  orbit = 0;
  /** Наклон камеры относительно базового (рад), диапазон −35°..+55° */
  pitch = 0;
  /** 0 — TPS, 1 — прицел от плеча */
  aimBlend = 0;
  /** Неподвижный таймер мыши: после паузы орбита возвращается за скейтером */
  private idle = 0;
  /** В верстаке орбиту задаёт код (камера смотрит на скейтера спереди) */
  lockOrbit = false;
  private readonly pivot = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3(0, 0, -1);
  private readonly right = new THREE.Vector3(1, 0, 0);

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Абсолютный курс взгляда камеры (для подруливания скейтера) */
  camYaw(heading: number): number {
    return heading + this.orbit;
  }

  /** Единичный вектор взгляда камеры (с учётом pitch) — основа прицела и автонаводки */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.fwd);
  }

  /** Обновление камеры; mouseDX/mouseDY — приращения мыши (PointerLock) */
  update(
    dt: number,
    skater: SkaterController,
    aimHeld: boolean,
    mouseDX: number,
    mouseDY: number,
    col: Collider,
  ): void {
    // Орбита мышью
    if (Math.abs(mouseDX) + Math.abs(mouseDY) > 0.01) {
      this.orbit -= mouseDX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - mouseDY * 0.0018, -35 * DEG, 55 * DEG);
      this.idle = 0;
    } else {
      this.idle += dt;
      if (this.idle > 1.2 && !this.lockOrbit) {
        this.orbit *= Math.exp(-dt * 1.4);
        this.pitch *= Math.exp(-dt * 1.2);
      }
    }
    if (this.lockOrbit) this.pitch *= Math.exp(-dt * 1.2);
    this.orbit = THREE.MathUtils.clamp(this.orbit, -Math.PI, Math.PI);
    if (Math.abs(this.orbit) < 1e-4) this.orbit = 0;

    // Направление взгляда (горизонталь = курс камеры, наклон = pitch)
    const yaw = this.camYaw(skater.heading);
    const elev = this.pitch;
    const cosE = Math.cos(elev);
    this.fwd.set(-Math.sin(yaw) * cosE, -Math.sin(elev), -Math.cos(yaw) * cosE).normalize();
    const back = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const rightV = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    this.right.copy(rightV);
    const k = aimHeld ? 1 : 0;
    this.aimBlend += (k - this.aimBlend) * Math.min(1, dt * (aimHeld ? 14 : 12));

    this.pivot.set(skater.pos.x, skater.pos.y + 1.1, skater.pos.z);

    // Целевая позиция: TPS или плечо, интерполяция по aimBlend
    const tpsDist = Math.hypot(TPS_UP, TPS_BACK);
    const tpsElev = TPS_ELEV + this.pitch;
    const tps = new THREE.Vector3()
      .addScaledVector(back, Math.cos(tpsElev) * tpsDist)
      .add(new THREE.Vector3(0, Math.sin(tpsElev) * tpsDist, 0));
    const sh = new THREE.Vector3()
      .addScaledVector(rightV, SH_RIGHT)
      .addScaledVector(back, SH_BACK)
      .add(new THREE.Vector3(0, SH_UP, 0));
    const offset = tps.lerp(sh, this.aimBlend);
    const desired = this.pivot.clone().add(offset);

    // Не проваливаться в стены: рейкаст от пивота к камере
    const dir = desired.clone().sub(this.pivot);
    const len = dir.length();
    if (len > 0.01) {
      dir.divideScalar(len);
      const hit = col.raycast(this.pivot, dir, len);
      if (hit < len) desired.copy(this.pivot).addScaledVector(dir, Math.max(0.35, hit - 0.25));
    }
    this.camera.position.lerp(desired, Math.min(1, dt * 16));

    // Взгляд: TPS — вперёд по курсу, прицел — по прицельной линии
    const look = this.pivot.clone().addScaledVector(this.fwd, 30);
    this.camera.lookAt(look);

    // FOV: TPS 78→90 от скорости, плечо 52
    const speed = Math.hypot(skater.vel.x, skater.vel.z);
    const tpsFov = 78 + THREE.MathUtils.clamp((speed - 12) / 20, 0, 1) * 12;
    const targetFov = THREE.MathUtils.lerp(tpsFov, 52, this.aimBlend);
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 10);
      this.camera.updateProjectionMatrix();
    }
  }
}
