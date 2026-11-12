import * as THREE from 'three';
import { Enemy, EnemyEnv } from '../combat/EnemyManager';
import { buildLaser, buildSniper } from './EnemyModels';

/** Враг 2: КИБЕР-ЯЩЕР СНАЙПЕР — 65 HP, прицел 1.3 с, вспышка 0.25 с, выстрел 22 урона */
export class LizardSniper extends Enemy {
  readonly type = 'sniper' as const;
  readonly deathColor = 0xaa33ff;
  readonly centerY = 1.0;
  private state: 'idle' | 'aim' | 'cool' = 'idle';
  private t = 0;
  private cooldown = 0;
  private readonly laser = buildLaser();
  private beeped = false;

  constructor(pos: THREE.Vector3) {
    super(pos, 65, buildSniper());
    this.laser.mesh.visible = false;
  }

  onDeath(env: EnemyEnv): void {
    super.onDeath(env);
    this.laser.mesh.visible = false;
  }

  dispose(scene: THREE.Scene): void {
    super.dispose(scene);
    scene.remove(this.laser.mesh);
  }

  update(dt: number, env: EnemyEnv): void {
    if (this.tickDeath(dt)) return;
    if (!this.alive) return;
    if (!this.laser.mesh.parent) env.scene.add(this.laser.mesh);
    const p = env.player.pos;
    const eye = new THREE.Vector3(this.group.position.x, this.group.position.y + 1.7, this.group.position.z);
    const target = env.player.pos.clone().add(new THREE.Vector3(0, 1.0, 0));
    const d = Math.hypot(p.x - this.group.position.x, p.z - this.group.position.z);
    const visible = d < 110 && env.col.lineClear(eye, target);
    this.faceTo(p.x, p.z, dt, 5);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.t += dt;
    const r = this.rig;
    r.armR.rotation.x = -1.2 + Math.sin(this.t * 2) * 0.03;
    r.armL.rotation.x = -0.4;
    r.legL.rotation.x = 0;
    r.legR.rotation.x = 0;

    if (this.state === 'idle') {
      this.laser.mesh.visible = false;
      if (visible && this.cooldown <= 0 && d < 90) {
        this.state = 'aim';
        this.t = 0;
        this.beeped = false;
        env.audio.playSniperCharge(1.3);
      }
      return;
    }
    if (this.state === 'aim') {
      if (!visible) {
        this.state = 'idle';
        this.laser.mesh.visible = false;
        return;
      }
      const eyeW = eye;
      const len = eyeW.distanceTo(target);
      this.laser.mesh.visible = true;
      this.laser.mesh.position.copy(eyeW).lerp(target, 0.5);
      this.laser.mesh.scale.set(1, 1, len);
      this.laser.mesh.lookAt(target);
      const warn = this.t >= 1.05;
      this.laser.mat.color.setHex(warn && Math.floor(this.t * 20) % 2 === 0 ? 0xffffff : 0x39ff14);
      if (warn && !this.beeped) {
        this.beeped = true;
        env.audio.playSniperBeep();
      }
      if (this.t >= 1.3) {
        env.audio.playSniperShot();
        const from = eye.clone();
        env.shots.enemyBolt(from, target, 70, 22, () => env.hurtPlayer(22, 'СНАЙПЕР'));
        this.state = 'cool';
        this.cooldown = 2.4;
        this.laser.mesh.visible = false;
      }
      return;
    }
    if (this.cooldown <= 0) this.state = 'idle';
  }
}
