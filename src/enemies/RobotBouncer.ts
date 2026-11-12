import * as THREE from 'three';
import { Enemy, EnemyEnv } from '../combat/EnemyManager';
import { buildBouncer } from './EnemyModels';

/** Кольцо баса, расходящееся по полу */
interface Ring {
  mesh: THREE.Mesh;
  r: number;
  hit: boolean;
  origin: THREE.Vector3;
}

const RING_MAX = 20;
const RING_SPEED = 16;

/** Враг 3: РОБОТ-ВЫШИБАЛА — 180 HP, раз в 3.2 с бьёт кулаками в пол: бас-кольцо до 20 м, урон 20 */
export class RobotBouncer extends Enemy {
  readonly type = 'robot' as const;
  readonly deathColor = 0xffaa33;
  readonly centerY = 1.7;
  private slamTimer = 3.2;
  private charge = -1;
  private rings: Ring[] = [];
  private readonly ringGeo = new THREE.TorusGeometry(1, 0.12, 4, 28);
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: 0xff8800 });

  constructor(pos: THREE.Vector3) {
    super(pos, 180, buildBouncer());
  }

  dispose(scene: THREE.Scene): void {
    super.dispose(scene);
    for (const ring of this.rings) scene.remove(ring.mesh);
    this.rings = [];
  }

  update(dt: number, env: EnemyEnv): void {
    this.updateRings(dt, env);
    if (this.tickDeath(dt)) return;
    if (!this.alive) return;
    const p = env.player.pos;
    const r = this.rig;
    const d = Math.hypot(p.x - this.group.position.x, p.z - this.group.position.z);

    // Удар по полу: зарядка 0.7 с (кулаки вверх), затем слэм и кольцо
    if (this.charge >= 0) {
      this.charge += dt;
      const k = Math.min(1, this.charge / 0.7);
      r.armL.rotation.x = -2.6 * k;
      r.armR.rotation.x = -2.6 * k;
      if (this.charge >= 0.7) {
        this.charge = -1;
        this.slamTimer = 3.2;
        r.armL.rotation.x = 0.4;
        r.armR.rotation.x = 0.4;
        env.audio.playSlam();
        this.spawnRing(env);
      }
      this.faceTo(p.x, p.z, dt, 6);
      return;
    }

    this.slamTimer -= dt;
    if (this.slamTimer <= 0) {
      this.charge = 0;
      return;
    }
    // Медленная ходьба на игрока
    if (d < 45 && d > 7) {
      const k = 3.2 / d;
      this.moveXZ((p.x - this.group.position.x) * k, (p.z - this.group.position.z) * k, dt, env);
    }
    this.faceTo(p.x, p.z, dt, 5);
    const step = Math.sin(env.time * 4);
    r.legL.rotation.x = step * 0.25;
    r.legR.rotation.x = -step * 0.25;
    r.armL.rotation.x = step * 0.1;
    r.armR.rotation.x = -step * 0.1;
  }

  private spawnRing(env: EnemyEnv): void {
    const mesh = new THREE.Mesh(this.ringGeo, this.ringMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(this.group.position.x, this.group.position.y + 0.1, this.group.position.z);
    mesh.scale.setScalar(0.5);
    env.scene.add(mesh);
    this.rings.push({ mesh, r: 0.5, hit: false, origin: mesh.position.clone() });
  }

  /** Кольцо расширяется; урон получают игроки, которые стоят на его пути и не выше 1.2 м над полом */
  private updateRings(dt: number, env: EnemyEnv): void {
    const p = env.player.pos;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.r += RING_SPEED * dt;
      ring.mesh.scale.setScalar(ring.r);
      ring.mesh.position.copy(ring.origin);
      if (!ring.hit) {
        const d = Math.hypot(p.x - ring.origin.x, p.z - ring.origin.z);
        const onRing = Math.abs(d - ring.r) < 1.2;
        const grounded = p.y < ring.origin.y + 1.2;
        if (onRing && grounded) {
          ring.hit = true;
          env.hurtPlayer(20, 'БАС-КОЛЬЦО');
        }
      }
      if (ring.r >= RING_MAX) {
        env.scene.remove(ring.mesh);
        this.rings.splice(i, 1);
      }
    }
  }
}
