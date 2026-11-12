import * as THREE from 'three';
import { Collider, Surface } from './Collider';
import { createPS1Material, lambert, pixelTexture } from '../shaders/PS1Material';
import { GrindStyle } from '../types';

export const RED = 0xff0033;
export const RED_EMISSIVE = 0xcc0022;

/** Текстура бегущих красных шевронов для перил и рамп */
function makeChevronCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#5a0014';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#ff0033';
    for (let i = 0; i < 4; i++) {
      const y0 = i * 16;
      g.beginPath();
      g.moveTo(0, y0 + 2);
      g.lineTo(32, y0 + 10);
      g.lineTo(64, y0 + 2);
      g.lineTo(64, y0 + 8);
      g.lineTo(32, y0 + 16);
      g.lineTo(0, y0 + 8);
      g.closePath();
      g.fill();
    }
    g.fillStyle = '#ffd0d8';
    for (let i = 0; i < 4; i++) {
      g.fillRect(28, i * 16 + 9, 8, 2);
    }
  }
  return c;
}

/**
 * Красный скейт-рельс: CatmullRom-сплайн, трубка и выборка точек для грайнда.
 * Точки сплайна задают ВЕРХ рельса; игрок едет на высоте точки + 0.12 м.
 */
export class TrickRail {
  readonly curve: THREE.CatmullRomCurve3;
  readonly length: number;
  readonly samples: THREE.Vector3[];
  readonly closed: boolean;
  readonly mat: THREE.MeshLambertMaterial;
  readonly map: THREE.CanvasTexture;
  highlight = 0;

  constructor(readonly id: number, points: THREE.Vector3[], closed: boolean, chevron: HTMLCanvasElement) {
    this.closed = closed;
    this.curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
    this.length = this.curve.getLength();
    const n = Math.max(8, Math.ceil(this.length * 2));
    this.samples = this.curve.getSpacedPoints(n);
    this.map = pixelTexture(chevron, Math.max(1, Math.round(this.length / 2)), 1);
    this.mat = createPS1Material({ color: RED, emissive: RED_EMISSIVE, emissiveIntensity: 1, map: this.map });
  }

  pointAt(s: number): THREE.Vector3 {
    return this.curve.getPointAt(THREE.MathUtils.clamp(s / this.length, 0, 1));
  }

  tangentAt(s: number): THREE.Vector3 {
    return this.curve.getTangentAt(THREE.MathUtils.clamp(s / this.length, 0, 1));
  }

  /** Ближайшая точка рельса к p: arc-length s, расстояние и точка */
  nearest(p: THREE.Vector3): { s: number; dist: number; point: THREE.Vector3 } {
    let best = { s: 0, dist: Infinity, point: this.samples[0] };
    const step = this.length / (this.samples.length - 1);
    for (let i = 0; i < this.samples.length; i++) {
      const d = this.samples[i].distanceTo(p);
      if (d < best.dist) best = { s: i * step, dist: d, point: this.samples[i] };
    }
    return best;
  }
}

export interface RampHint {
  text: string;
  x: number;
  y: number;
  z: number;
}

/**
 * Менеджер красных объектов уровня: перила (TrickRail) и рампы/кикеры (Surface kind 'ramp'/'mega').
 * Весь красный декор пульсирует в бит (emissive) и бегут шевроны.
 */
export class TrickObjects {
  readonly group: THREE.Group;
  readonly rails: TrickRail[] = [];
  readonly ramps: Surface[] = [];
  private readonly mats: THREE.MeshLambertMaterial[] = [];
  private readonly chevron: HTMLCanvasElement;
  private readonly rampMeshes = new Map<Surface, THREE.Group>();
  private nextId = 1;
  private readonly postMat = lambert(0x2a2a3a);
  private readonly postGeo = new THREE.BoxGeometry(0.12, 1, 0.12);

  constructor(parent: THREE.Group) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.chevron = makeChevronCanvas();
  }

  /** Перила по точкам сплайна (верх рельса) с опорами к полу */
  addRail(points: THREE.Vector3[], closed = false, supports = true): TrickRail {
    const rail = new TrickRail(this.nextId++, points, closed, this.chevron);
    this.rails.push(rail);
    this.mats.push(rail.mat);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(rail.curve, Math.max(24, Math.ceil(rail.length * 1.5)), 0.06, 6, closed), rail.mat);
    this.group.add(tube);
    if (supports) {
      const step = 4;
      const count = Math.floor(rail.length / step);
      for (let i = 0; i <= count; i++) {
        const p = rail.pointAt(i * step);
        if (p.y < 0.35) continue;
        const post = new THREE.Mesh(this.postGeo, this.postMat);
        post.scale.set(1, p.y - 0.02, 1);
        post.position.set(p.x, (p.y - 0.02) / 2, p.z);
        this.group.add(post);
      }
    }
    return rail;
  }

  /**
   * Рампа/кикер: плоскость с уклоном slope, начинается в origin (низкий край) и уходит по yaw.
   * Визуал: клин с красными шевронами и боковыми бортами. Поверхность регистрируется в коллайдере.
   */
  addRamp(
    col: Collider,
    origin: THREE.Vector3,
    yaw: number,
    slope: number,
    length: number,
    width: number,
    kind: 'ramp' | 'mega' = 'ramp',
    tag = kind,
  ): { surface: Surface; group: THREE.Group } {
    const surface = new Surface({
      kind,
      tag,
      origin,
      yaw,
      slope,
      shape: { type: 'rect', u0: 0, u1: length, v0: -width / 2, v1: width / 2 },
    });
    col.surfaces.push(surface);
    this.ramps.push(surface);

    const g = new THREE.Group();
    g.position.copy(origin);
    g.rotation.y = yaw;
    const tilt = new THREE.Group();
    tilt.rotation.x = -Math.atan(slope);
    g.add(tilt);
    const map = pixelTexture(this.chevron, Math.max(1, Math.round(length / 2)), Math.max(1, Math.round(width / 2)));
    const topMat = createPS1Material({ color: RED, emissive: RED_EMISSIVE, emissiveIntensity: 1, map });
    this.mats.push(topMat);
    const slopeLen = Math.hypot(length, slope * length);
    const top = new THREE.Mesh(new THREE.BoxGeometry(width, 0.3, slopeLen), topMat);
    // Клин: ось вдоль +Z в системе наклона; центр — на середине наклонного пути
    top.position.set(0, -0.15, slopeLen / 2);
    tilt.add(top);
    const sideMat = createPS1Material({ color: RED, emissive: RED_EMISSIVE, emissiveIntensity: 0.6 });
    this.mats.push(sideMat);
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, slopeLen), sideMat);
      side.position.set((sx * width) / 2, -0.35, slopeLen / 2);
      tilt.add(side);
    }
    this.group.add(g);
    this.rampMeshes.set(surface, g);
    return { surface, group: g };
  }

  /** Обновление: пульс в бит и бегущие шевроны */
  update(time: number, beat: number): void {
    const k = 0.7 + beat * 1.5;
    for (const m of this.mats) m.emissiveIntensity = k;
    for (const r of this.rails) {
      r.map.offset.x = -time * 0.9;
      r.highlight = Math.max(0, r.highlight - 0.05);
    }
  }

  /** Подсветка рельса при подъезде (вспыхивает ярче) */
  highlightNear(p: THREE.Vector3): void {
    for (const r of this.rails) {
      const { dist } = r.nearest(p);
      r.highlight = Math.max(r.highlight, THREE.MathUtils.clamp(1 - dist / 3.5, 0, 1));
      r.mat.color.setHex(RED);
      r.mat.emissiveIntensity = 0.8 + r.highlight * 1.6;
    }
  }

  /** Ближайший рельс в радиусе maxDist (для SPACE) */
  findRail(p: THREE.Vector3, maxDist: number): { rail: TrickRail; s: number; dist: number } | null {
    let best: { rail: TrickRail; s: number; dist: number } | null = null;
    for (const r of this.rails) {
      const n = r.nearest(p);
      if (n.dist <= maxDist && (!best || n.dist < best.dist)) best = { rail: r, s: n.s, dist: n.dist };
    }
    return best;
  }

  /** Подсказка над ближайшим трюк-объектом (для HUD) */
  hintAt(p: THREE.Vector3, radius = 3.5): RampHint | null {
    let best: RampHint | null = null;
    let bestD = radius;
    for (const r of this.rails) {
      const n = r.nearest(p);
      if (n.dist < bestD) {
        bestD = n.dist;
        best = { text: '[SPACE: ГРАЙНД]', x: n.point.x, y: n.point.y + 0.9, z: n.point.z };
      }
    }
    for (const s of this.ramps) {
      if (s.kind !== 'ramp' && s.kind !== 'mega') continue;
      const d = s.topEdgeDistance(p);
      if (d < bestD && s.enabled) {
        bestD = d;
        const sh = s.shape as { u1: number };
        const top = s.origin.clone().addScaledVector(s.U, sh.u1);
        top.y = s.origin.y + s.slope * sh.u1;
        best = { text: '[SPACE: ВЫЛЕТ]', x: top.x, y: top.y + 1.4, z: top.z };
      }
    }
    return best;
  }

  clearGroup(): void {
    this.group.clear();
  }

  /** Гарантирует, что стиль грайнда выбран (для совместимости типов) */
  static randomGrindStyle(): GrindStyle {
    const styles: GrindStyle[] = ['50-50', 'boardslide', 'nosegrind', 'slavslide'];
    return styles[Math.floor(Math.random() * styles.length)];
  }
}
