import * as THREE from 'three';
import { Enemy, EnemyEnv } from '../combat/EnemyManager';
import { buildRaver } from './EnemyModels';

/** Враг 1: ЯЩЕР-РЕЙВЕР — быстрый ближний бой, 45 HP, 11 м/с, выпад 15 урона */
export class LizardRaver extends Enemy {
  readonly type = 'raver' as const;
  readonly deathColor = 0x39ff14;
  readonly centerY = 0.9;
  private lunge = 0;
  private phase = Math.random() * 6;

  constructor(pos: THREE.Vector3) {
    super(pos, 45, buildRaver());
  }

  update(dt: number, env: EnemyEnv): void {
    if (this.tickDeath(dt)) return;
    if (!this.alive) return;
    const p = env.player.pos;
    const dx = p.x - this.group.position.x;
    const dz = p.z - this.group.position.z;
    const d = Math.hypot(dx, dz);
    this.lunge = Math.max(0, this.lunge - dt);
    this.phase += dt;
    const r = this.rig;
    const swing = Math.sin(this.phase * 14);
    if (d < 1.7) {
      // Выпад: руки вперёд, удар по игроку
      r.armL.rotation.x = -1.4;
      r.armR.rotation.x = -1.4;
      if (this.lunge <= 0) {
        this.lunge = 1.1;
        env.hurtPlayer(15, 'ЯЩЕР-РЕЙВЕР');
      }
      this.faceTo(p.x, p.z, dt, 12);
    } else {
      // Бег наперерез: скорость 11 м/с
      const k = 11 / Math.max(d, 0.01);
      this.moveXZ(dx * k, dz * k, dt, env);
      this.faceTo(p.x, p.z, dt, 8);
      r.armL.rotation.x = 0.8 + swing * 0.7;
      r.armR.rotation.x = 0.8 - swing * 0.7;
    }
    r.legL.rotation.x = swing * 0.8;
    r.legR.rotation.x = -swing * 0.8;
    r.body.position.y = Math.abs(Math.sin(this.phase * 14)) * 0.08;
    r.extra.tail.rotation.y = Math.sin(this.phase * 6) * 0.4;
    r.extra.tail2.rotation.y = Math.sin(this.phase * 6 - 0.6) * 0.5;
  }
}
