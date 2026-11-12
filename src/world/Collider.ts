import * as THREE from 'three';

export type SurfaceKind = 'floor' | 'ramp' | 'mega' | 'platform' | 'acid' | 'escalator';

/**
 * Форма поверхности в локальных координатах (u — вдоль U, v — вдоль V от origin):
 *  rect   — прямоугольник u∈[u0,u1], v∈[v0,v1]
 *  circle — круг радиуса r с центром в origin
 *  ring   — кольцо rIn..rOut с центром в origin
 */
export type SurfaceShape =
  | { type: 'rect'; u0: number; u1: number; v0: number; v1: number }
  | { type: 'circle'; r: number }
  | { type: 'ring'; rIn: number; rOut: number };

export interface SurfaceOptions {
  kind: SurfaceKind;
  tag?: string;
  origin: THREE.Vector3;
  yaw?: number;
  slope?: number;
  shape: SurfaceShape;
}

/**
 * Наклонная/плоская поверхность: высота y = origin.y + slope * u.
 * U = (sin yaw, 0, cos yaw), V = (cos yaw, 0, -sin yaw). Рампы, эскалатор, платформы, арена — всё через неё.
 */
export class Surface {
  readonly kind: SurfaceKind;
  readonly tag: string;
  readonly origin: THREE.Vector3;
  readonly yaw: number;
  readonly slope: number;
  shape: SurfaceShape;
  enabled = true;
  readonly U: THREE.Vector3;
  readonly V: THREE.Vector3;

  constructor(o: SurfaceOptions) {
    this.kind = o.kind;
    this.tag = o.tag ?? o.kind;
    this.origin = o.origin.clone();
    this.yaw = o.yaw ?? 0;
    this.slope = o.slope ?? 0;
    this.shape = o.shape;
    this.U = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.V = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  local(x: number, z: number): { u: number; v: number } {
    const dx = x - this.origin.x;
    const dz = z - this.origin.z;
    return { u: dx * this.U.x + dz * this.U.z, v: dx * this.V.x + dz * this.V.z };
  }

  /** Высота поверхности в точке (x,z) или null, если точка вне поверхности */
  heightAt(x: number, z: number): number | null {
    if (!this.enabled) return null;
    const { u, v } = this.local(x, z);
    const s = this.shape;
    if (s.type === 'rect') {
      if (u < s.u0 || u > s.u1 || v < s.v0 || v > s.v1) return null;
    } else if (s.type === 'circle') {
      if (u * u + v * v > s.r * s.r) return null;
    } else {
      const r2 = u * u + v * v;
      if (r2 > s.rOut * s.rOut || r2 < s.rIn * s.rIn) return null;
    }
    return this.origin.y + this.slope * u;
  }

  /** Горизонтальное направление роста высоты (вверх по рампе) */
  uphill(): THREE.Vector3 {
    return this.U.clone().multiplyScalar(this.slope >= 0 ? 1 : -1);
  }

  /** Расстояние от точки до верхнего края рампы (rect со slope>0, край u=u1) */
  topEdgeDistance(p: THREE.Vector3): number {
    const s = this.shape;
    if (s.type !== 'rect') return Infinity;
    const y = this.origin.y + this.slope * s.u1;
    const a = new THREE.Vector3(
      this.origin.x + this.U.x * s.u1 + this.V.x * s.v0,
      y,
      this.origin.z + this.U.z * s.u1 + this.V.z * s.v0,
    );
    const b = new THREE.Vector3(
      this.origin.x + this.U.x * s.u1 + this.V.x * s.v1,
      y,
      this.origin.z + this.U.z * s.u1 + this.V.z * s.v1,
    );
    const ab = b.clone().sub(a);
    const len2 = ab.lengthSq();
    const t = len2 > 1e-6 ? THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / len2, 0, 1) : 0;
    const c = a.clone().addScaledVector(ab, t);
    return p.distanceTo(c);
  }

  setRectLength(u1: number): void {
    if (this.shape.type === 'rect') this.shape = { ...this.shape, u1 };
  }
}

export interface Wall {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface GroundHit {
  surface: Surface;
  height: number;
}

function rayAABB(o: THREE.Vector3, d: THREE.Vector3, w: Wall, maxT: number): number | null {
  let tmin = 0;
  let tmax = maxT;
  const axes: [number, number, number, number][] = [
    [o.x, d.x, w.minX, w.maxX],
    [o.y, d.y, w.minY, w.maxY],
    [o.z, d.z, w.minZ, w.maxZ],
  ];
  for (const [oo, dd, mn, mx] of axes) {
    if (Math.abs(dd) < 1e-9) {
      if (oo < mn || oo > mx) return null;
      continue;
    }
    let t1 = (mn - oo) / dd;
    let t2 = (mx - oo) / dd;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/**
 * Collider: набор поверхностей (для высоты), AABB-стен (для XZ-коллизий и LOS) и опционально круглая граница арены.
 */
export class Collider {
  surfaces: Surface[] = [];
  walls: Wall[] = [];
  bound: { cx: number; cz: number; r: number } | null = null;

  /** Наивысшая поверхность под точкой, не выше refY + step (ступени/спуски/платформы) */
  groundAt(x: number, z: number, refY: number, step = 0.9): GroundHit | null {
    let best: GroundHit | null = null;
    for (const s of this.surfaces) {
      const h = s.heightAt(x, z);
      if (h === null || h > refY + step) continue;
      if (!best || h > best.height) best = { surface: s, height: h };
    }
    return best;
  }

  /**
   * Выталкивает точку p из стен (по XZ) и за пределы круглой арены.
   * Стена учитывается только если ноги ниже её верха и голова выше её низа.
   * Возвращает нормаль контакта или null.
   */
  resolveXZ(p: THREE.Vector3, radius: number, feetY: number): THREE.Vector3 | null {
    let contact: THREE.Vector3 | null = null;
    if (this.bound) {
      const { cx, cz, r } = this.bound;
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d = Math.hypot(dx, dz);
      const lim = r - radius;
      if (d > lim && d > 1e-6) {
        const k = lim / d;
        p.x = cx + dx * k;
        p.z = cz + dz * k;
        contact = new THREE.Vector3(-dx / d, 0, -dz / d);
      }
    }
    for (const w of this.walls) {
      if (feetY > w.maxY - 0.15 || feetY + 1.7 < w.minY) continue;
      const minX = w.minX - radius;
      const maxX = w.maxX + radius;
      const minZ = w.minZ - radius;
      const maxZ = w.maxZ + radius;
      if (p.x <= minX || p.x >= maxX || p.z <= minZ || p.z >= maxZ) continue;
      const dl = p.x - minX;
      const dr = maxX - p.x;
      const dn = p.z - minZ;
      const df = maxZ - p.z;
      const m = Math.min(dl, dr, dn, df);
      if (m === dl) {
        p.x = minX;
        contact = new THREE.Vector3(-1, 0, 0);
      } else if (m === dr) {
        p.x = maxX;
        contact = new THREE.Vector3(1, 0, 0);
      } else if (m === dn) {
        p.z = minZ;
        contact = new THREE.Vector3(0, 0, -1);
      } else {
        p.z = maxZ;
        contact = new THREE.Vector3(0, 0, 1);
      }
    }
    return contact;
  }

  /** Расстояние до первой стены вдоль луча (d — нормализован), иначе maxDist */
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxDist: number): number {
    let best = maxDist;
    for (const w of this.walls) {
      const t = rayAABB(o, d, w, best);
      if (t !== null && t < best) best = t;
    }
    return best;
  }

  /** Есть ли прямая видимость между двумя точками (без стен) */
  lineClear(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-3) return true;
    dir.divideScalar(len);
    return this.raycast(a, dir, len) >= len - 0.05;
  }
}
