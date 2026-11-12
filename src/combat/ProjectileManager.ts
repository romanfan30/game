import * as THREE from 'three';
import { lambert, unlit } from '../shaders/PS1Material';
import { ClubVFX } from '../world/ClubVFX';
import { Collider } from '../world/Collider';

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
}

interface Casing {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

interface Flash {
  mesh: THREE.Object3D;
  life: number;
}

interface Arc {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

/** Снаряд врага: снайперский болт или диско-сфера босса */
export interface EnemyShot {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  damage: number;
  radius: number;
  /** Вызывается при попадании в игрока */
  onHit: () => void;
}

/**
 * ProjectileManager: визуальные трассеры, гильзы, вспышки дула, дуга ножа и снаряды врагов.
 * Все геометрии/материалы — общие, объекты удаляются из сцены по таймеру.
 */
export class ProjectileManager {
  private readonly tracers: Tracer[] = [];
  private readonly casings: Casing[] = [];
  private readonly flashes: Flash[] = [];
  private readonly arcs: Arc[] = [];
  readonly shots: EnemyShot[] = [];

  private readonly tracerGeo = new THREE.BoxGeometry(0.035, 0.035, 1);
  private readonly tracerMat = unlit(0xffe84a, 0.9, true);
  private readonly casingGeo = new THREE.BoxGeometry(0.03, 0.03, 0.06);
  private readonly casingMat = lambert(0xd9b24a, 0xd9b24a, 0.4);
  private readonly flashGeo = new THREE.PlaneGeometry(0.5, 0.5);
  private readonly flashMat = unlit(0xffff66, 1, true);
  private readonly boltGeo = new THREE.BoxGeometry(0.12, 0.12, 0.9);
  private readonly boltMat = unlit(0x66ff88, 1, true);
  private readonly discoGeo = new THREE.IcosahedronGeometry(0.35, 0);
  private readonly discoMat = unlit(0xff66dd, 1, true);
  private readonly arcGeo = new THREE.RingGeometry(3.4, 4.6, 16, 1, -Math.PI * 0.33, Math.PI * 0.66);
  private readonly arcMat = unlit(0xbfffff, 0.75, true);

  constructor(private readonly scene: THREE.Scene, private readonly vfx: ClubVFX) {}

  /** Трассер от дула до точки попадания (или дальней точки) */
  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const len = from.distanceTo(to);
    const mesh = new THREE.Mesh(this.tracerGeo, this.tracerMat);
    mesh.position.copy(from).lerp(to, 0.5);
    mesh.scale.set(1, 1, Math.max(0.1, len));
    mesh.lookAt(to);
    this.scene.add(mesh);
    this.tracers.push({ mesh, life: 0.06 });
  }

  /** Вспышка дула: крест из двух плоскостей, случайно повернутый */
  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3): void {
    const g = new THREE.Group();
    g.position.copy(pos);
    g.lookAt(pos.clone().add(dir));
    const a = new THREE.Mesh(this.flashGeo, this.flashMat);
    const b = new THREE.Mesh(this.flashGeo, this.flashMat);
    b.rotation.z = Math.PI / 2;
    a.rotation.z = Math.random() * Math.PI;
    b.rotation.z += a.rotation.z;
    g.add(a, b);
    this.scene.add(g);
    this.flashes.push({ mesh: g, life: 0.05 });
  }

  /** Гильза, вылетающая вправо и вверх */
  casing(pos: THREE.Vector3, right: THREE.Vector3): void {
    const mesh = new THREE.Mesh(this.casingGeo, this.casingMat);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    const vel = right.clone().multiplyScalar(2.5).add(new THREE.Vector3(0, 2.4, 0));
    this.casings.push({ mesh, vel, life: 0.9 });
  }

  /** Дуга удара ножа (неоновый сектор перед игроком) */
  slashArc(center: THREE.Vector3, heading: number): void {
    const mesh = new THREE.Mesh(this.arcGeo, this.arcMat.clone());
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(center.x, center.y + 0.6, center.z);
    mesh.rotation.z = heading;
    this.scene.add(mesh);
    this.arcs.push({ mesh, life: 0.22, maxLife: 0.22 });
  }

  /** Снайперский болт (зелёный) с направлением и уроном */
  enemyBolt(from: THREE.Vector3, to: THREE.Vector3, speed: number, damage: number, onHit: () => void): void {
    const mesh = new THREE.Mesh(this.boltGeo, this.boltMat);
    mesh.position.copy(from);
    const dir = to.clone().sub(from).normalize();
    mesh.lookAt(from.clone().add(dir));
    this.scene.add(mesh);
    this.shots.push({
      mesh,
      pos: from.clone(),
      vel: dir.multiplyScalar(speed),
      life: 3,
      damage,
      radius: 0.7,
      onHit,
    });
  }

  /** Диско-сфера босса (медленная, большая дальность) */
  discoOrb(from: THREE.Vector3, to: THREE.Vector3, speed: number, damage: number, onHit: () => void): void {
    const mesh = new THREE.Mesh(this.discoGeo, this.discoMat);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.shots.push({
      mesh,
      pos: from.clone(),
      vel: to.clone().sub(from).normalize().multiplyScalar(speed),
      life: 6,
      damage,
      radius: 0.9,
      onHit,
    });
  }

  /**
   * Обновление снарядов врагов: движение, стены (по коллайдеру) и попадание в игрока.
   * playerCenter — центр корпуса игрока.
   */
  updateShots(dt: number, playerCenter: THREE.Vector3, col: Collider, spin: number): void {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.life -= dt;
      s.pos.addScaledVector(s.vel, dt);
      s.mesh.position.copy(s.pos);
      s.mesh.rotation.y += spin * dt;
      let remove = s.life <= 0;
      if (!remove && s.pos.distanceTo(playerCenter) < s.radius) {
        s.onHit();
        remove = true;
      }
      if (!remove) {
        for (const w of col.walls) {
          if (s.pos.x > w.minX && s.pos.x < w.maxX && s.pos.z > w.minZ && s.pos.z < w.maxZ && s.pos.y > w.minY && s.pos.y < w.maxY) {
            remove = true;
            this.vfx.burst(s.pos, 0x66ff88, 10, 6, 0.4, 0.1, 6);
            break;
          }
        }
      }
      if (remove) {
        this.scene.remove(s.mesh);
        this.shots.splice(i, 1);
      }
    }
  }

  /** Удаляем все снаряды (при смерти/рестарте уровня) */
  clearShots(): void {
    for (const s of this.shots) this.scene.remove(s.mesh);
    this.shots.length = 0;
  }

  update(dt: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        this.flashes.splice(i, 1);
      }
    }
    for (let i = this.casings.length - 1; i >= 0; i--) {
      const c = this.casings[i];
      c.life -= dt;
      c.vel.y -= 18 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += 14 * dt;
      if (c.mesh.position.y < 0 || c.life <= 0) {
        this.scene.remove(c.mesh);
        this.casings.splice(i, 1);
      }
    }
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      a.life -= dt;
      const k = Math.max(0, a.life / a.maxLife);
      (a.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * k;
      a.mesh.scale.setScalar(1 + (1 - k) * 0.25);
      if (a.life <= 0) {
        this.scene.remove(a.mesh);
        (a.mesh.material as THREE.Material).dispose();
        this.arcs.splice(i, 1);
      }
    }
  }
}
