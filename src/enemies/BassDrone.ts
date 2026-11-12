import * as THREE from 'three';
import { Enemy, EnemyEnv } from '../combat/EnemyManager';
import { buildDrone } from './EnemyModels';

/** Враг 4: БАС-ДРОН КАМИКАДЗЕ — 30 HP, парит на 3–6 м, взрыв через 0.6 с после захвата (18 урона), цепной взрыв при смерти */
export class BassDrone extends Enemy {
  readonly type = 'drone' as const;
  readonly deathColor = 0xff8800;
  readonly centerY = 0;
  private hover: number;
  private armT = -1;
  private diveT = 0;
  private exploded = false;
  private bob = Math.random() * 6;

  constructor(pos: THREE.Vector3) {
    super(pos, 30, buildDrone());
    this.hover = 3 + Math.random() * 3;
  }

  onDeath(env: EnemyEnv): void {
    // Взрыв дрона при гибели: соседние враги получают урон (цепочка через менеджер)
    const c = this.group.position.clone();
    c.y += 1;
    env.vfx.burst(c, 0xff8800, 36, 12, 0.6, 0.16, 6);
    env.audio.playExplosion(1);
    env.explode(c, 4, 30, this);
  }

  update(dt: number, env: EnemyEnv): void {
    if (this.tickDeath(dt)) return;
    if (!this.alive) return;
    this.bob += dt;
    const p = env.player.pos;
    const r = this.rig;
    const wing = Math.sin(env.time * 40) * 0.6;
    r.extra.wingL.rotation.z = wing;
    r.extra.wingR.rotation.z = -wing;
    r.extra.diff.scale.setScalar(1 + Math.sin(env.time * 12) * 0.2);

    if (this.armT < 0) {
      // Парение над землёй: высота 3–6 м, покачивание
      const floor = env.floorAt(this.group.position.x, this.group.position.z, this.group.position.y);
      const targetY = floor + this.hover + Math.sin(this.bob * 1.3) * 0.3;
      this.group.position.y += (targetY - this.group.position.y) * Math.min(1, dt * 3);
      const d = Math.hypot(p.x - this.group.position.x, p.z - this.group.position.z);
      if (d < 26 && env.col.lineClear(this.group.position, p)) {
        this.armT = 0;
        env.audio.playDroneWhine(0.6);
      }
      return;
    }

    this.armT += dt;
    if (this.armT < 0.6) {
      // Прицел: нарастающий писк, дрон дрожит
      this.group.position.x += Math.sin(env.time * 50) * 0.01;
      this.faceTo(p.x, p.z, dt, 10);
      return;
    }
    // Пикирование
    this.diveT += dt;
    const target = new THREE.Vector3(p.x, p.y + 0.9, p.z);
    const dir = target.clone().sub(this.group.position);
    const dist = dir.length();
    if (dist > 1e-3) dir.divideScalar(dist);
    this.group.position.addScaledVector(dir, Math.min(dist, 18 * dt));
    this.faceTo(p.x, p.z, dt, 14);
    if (dist < 1.6 || this.diveT > 1.5) this.detonate(env);
  }

  /** Самоподрыв у игрока: урон 18 в радиусе 3.5 м, затем враг удаляется менеджером */
  private detonate(env: EnemyEnv): void {
    if (this.exploded) return;
    this.exploded = true;
    this.alive = false;
    this.expired = true;
    env.audio.playExplosion(0.8);
    const c = this.group.position.clone();
    c.y += 1;
    env.vfx.burst(c, 0xff8800, 30, 10, 0.5, 0.16, 6);
    if (c.distanceTo(env.player.pos.clone().add(new THREE.Vector3(0, 0.9, 0))) < 3.5) {
      env.hurtPlayer(18, 'БАС-ДРОН');
    }
  }
}
