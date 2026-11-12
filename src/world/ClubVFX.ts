import * as THREE from 'three';
import { createPS1BasicMaterial, lambert, unlit } from '../shaders/PS1Material';

const NEON = [0x00ffcc, 0xff00ff, 0x39ff14, 0x00f0ff, 0xff007f, 0xffe600];

/** Пул частиц на InstancedMesh (искры, кровь, конфетти, взрывы) */
export class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private readonly parts: {
    alive: boolean;
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    life: number;
    maxLife: number;
    size: number;
    gravity: number;
  }[] = [];
  private cursor = 0;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();

  constructor(scene: THREE.Scene, size = 700) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = createPS1BasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, size);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < size; i++) {
      this.parts.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, maxLife: 1, size: 0.1, gravity: 0 });
      this.dummy.position.set(0, -1000, 0);
      this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.color.setHex(0xffffff));
    }
    scene.add(this.mesh);
  }

  burst(pos: THREE.Vector3, hex: number, count: number, speed: number, life: number, size = 0.12, gravity = 18): void {
    for (let n = 0; n < count; n++) {
      let idx = -1;
      for (let k = 0; k < this.parts.length; k++) {
        const i = (this.cursor + k) % this.parts.length;
        if (!this.parts[i].alive) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return;
      this.cursor = (idx + 1) % this.parts.length;
      const p = this.parts[idx];
      p.alive = true;
      p.pos.copy(pos);
      const r = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize();
      p.vel.copy(r).multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      p.life = life * (0.6 + Math.random() * 0.6);
      p.maxLife = p.life;
      p.size = size * (0.6 + Math.random() * 0.8);
      p.gravity = gravity;
      this.mesh.setColorAt(idx, this.color.setHex(hex));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    let colorDirty = false;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        this.dummy.position.set(0, -1000, 0);
        this.dummy.scale.setScalar(0);
      } else {
        p.vel.y -= p.gravity * dt;
        p.pos.addScaledVector(p.vel, dt);
        if (p.pos.y < 0.02) {
          p.pos.y = 0.02;
          p.vel.multiplyScalar(0.3);
        }
        const s = p.size * (p.life / p.maxLife);
        this.dummy.position.copy(p.pos);
        this.dummy.scale.setScalar(Math.max(0.001, s));
      }
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      colorDirty = true;
    }
    if (colorDirty) this.mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty && this.mesh.instanceColor) colorDirty = false;
  }
}

/** Клубный лазер: открытый полупрозрачный конус, вращается веером и дёргается на бит */
interface LaserBeam {
  pivot: THREE.Group;
  mat: THREE.MeshBasicMaterial;
  phase: number;
  speed: number;
  amp: number;
}

interface LaserRig {
  beams: LaserBeam[];
  kick: number;
}

/** Текстура неонового баннера с мемом (CanvasTexture) */
function drawBannerCanvas(text: string, hex: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  if (!g) return c;
  g.fillStyle = 'rgba(12, 0, 24, 0.82)';
  g.fillRect(0, 0, 512, 128);
  const color = '#' + hex.toString(16).padStart(6, '0');
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.strokeRect(6, 6, 500, 116);
  let size = 44;
  g.font = `bold ${size}px "Courier New", monospace`;
  while (g.measureText(text).width > 470 && size > 14) {
    size -= 2;
    g.font = `bold ${size}px "Courier New", monospace`;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 18;
  g.fillStyle = '#ffffff';
  g.fillText(text, 256, 66);
  g.shadowBlur = 0;
  g.fillStyle = color;
  g.fillText(text, 256, 66);
  return c;
}

/**
 * ClubVFX: лазеры, стробоскопы (пул PointLight), танцпол, неоновые баннеры, частицы.
 * Реакция на бит: onBeat(beat) вспыхивает стробы, дёргает лазеры, меняет плитки пола.
 */
export class ClubVFX {
  readonly particles: ParticlePool;
  private readonly rigs: LaserRig[] = [];
  private readonly floors: THREE.MeshBasicMaterial[][] = [];
  private readonly bannerTex = new Map<string, THREE.CanvasTexture>();
  private readonly strobeBase: number[] = [];
  private flash = 0;
  /** Интенсивность шоу: 1 — обычная, 2.5 — 220 BPM финал */
  intensity = 1;

  constructor(private readonly scene: THREE.Scene, private readonly lights: THREE.PointLight[]) {
    this.particles = new ParticlePool(scene);
    for (const l of lights) this.strobeBase.push(0);
  }

  burst(pos: THREE.Vector3, hex: number, count: number, speed: number, life: number, size = 0.12, gravity = 18): void {
    this.particles.burst(pos, hex, count, speed, life, size, gravity);
  }

  /** Клубный лазер (конус) под потолком */
  addLaserRig(parent: THREE.Group, center: THREE.Vector3, count: number): void {
    const beams: LaserBeam[] = [];
    for (let i = 0; i < count; i++) {
      const pivot = new THREE.Group();
      pivot.position.copy(center);
      const mat = unlit(NEON[(i + Math.floor(Math.random() * 3)) % 3], 0.16, true);
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 1.1, 1, 12, 1, true), mat);
      cone.scale.set(1, 26, 1);
      cone.position.y = -13;
      pivot.add(cone);
      parent.add(pivot);
      beams.push({ pivot, mat, phase: Math.random() * 6.28, speed: 0.6 + Math.random() * 0.9, amp: 0.5 });
    }
    this.rigs.push({ beams, kick: 0 });
  }

  /** Неоновый баннер (плоскость с CanvasTexture) */
  makeBanner(text: string, hex: number, w: number, h: number): THREE.Mesh {
    const key = `${text}|${hex}`;
    let tex = this.bannerTex.get(key);
    if (!tex) {
      tex = new THREE.CanvasTexture(drawBannerCanvas(text, hex));
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.bannerTex.set(key, tex);
    }
    const mat = createPS1BasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  }

  /** Танцпол: сетка светящихся плиток; возвращает материалы для вспышек */
  addDanceFloor(parent: THREE.Group, cx: number, cz: number, w: number, d: number, tile = 2): THREE.MeshBasicMaterial[] {
    const mats = NEON.slice(0, 5).map((c) => createPS1BasicMaterial({ color: c, side: THREE.DoubleSide }));
    this.floors.push(mats);
    const geo = new THREE.PlaneGeometry(tile * 0.94, tile * 0.94);
    geo.rotateX(-Math.PI / 2);
    const nx = Math.floor(w / tile);
    const nz = Math.floor(d / tile);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const m = new THREE.Mesh(geo, mats[(i * 3 + j * 7) % mats.length]);
        m.position.set(cx - w / 2 + tile * (i + 0.5), 0.02, cz - d / 2 + tile * (j + 0.5));
        parent.add(m);
      }
    }
    return mats;
  }

  /** Стробоскоп: индекс в пуле PointLight, позиция */
  placeStrobe(i: number, pos: THREE.Vector3, color = 0x00ffcc): void {
    const l = this.lights[i % this.lights.length];
    l.position.copy(pos);
    l.color.setHex(color);
    this.strobeBase[i % this.lights.length] = 1;
  }

  onBeat(beat: number): void {
    this.flash = 1;
    for (const rig of this.rigs) {
      rig.kick = 1;
    }
    if (beat % 4 === 0) {
      for (const mats of this.floors) {
        for (const m of mats) {
          m.color.setHex(NEON[Math.floor(Math.random() * NEON.length)]);
        }
      }
    }
  }

  update(dt: number, time: number): void {
    this.particles.update(dt);
    this.flash *= Math.exp(-dt * 10);
    for (const rig of this.rigs) {
      rig.kick *= Math.exp(-dt * 6);
      for (const b of rig.beams) {
        const amp = b.amp * (1 + rig.kick * 1.6) * (0.7 + this.intensity * 0.3);
        b.pivot.rotation.x = Math.sin(time * b.speed + b.phase) * amp;
        b.pivot.rotation.z = Math.cos(time * b.speed * 0.7 + b.phase) * amp;
        b.mat.opacity = 0.1 + rig.kick * 0.22;
      }
    }
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      if (this.strobeBase[i] > 0) {
        l.intensity = this.flash * 6 * this.intensity + 0.4;
      } else {
        l.intensity = 0;
      }
    }
  }
}

export { lambert };
