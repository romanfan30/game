import * as THREE from 'three';
import { createPS1Material, lambert, pixelTexture, unlit } from '../shaders/PS1Material';
import { Enemy } from '../combat/EnemyManager';
import { BassDrone } from '../enemies/BassDrone';
import { BossDJArchon, BossPhase } from '../enemies/BossDJArchon';
import { LizardRaver } from '../enemies/LizardRaver';
import { LizardSniper } from '../enemies/LizardSniper';
import { RobotBouncer } from '../enemies/RobotBouncer';
import { EnemyType, LevelId, RankThresholds, SpawnSpec, ZoneSpec } from '../types';
import { ClubVFX } from './ClubVFX';
import { Collider, Surface } from './Collider';
import { TrickObjects, TrickRail } from './TrickObjects';

/** Создание врага по типу (фабрика, см. §2) */
export function makeEnemy(type: EnemyType, pos: THREE.Vector3): Enemy {
  switch (type) {
    case 'raver':
      return new LizardRaver(pos);
    case 'sniper':
      return new LizardSniper(pos);
    case 'robot':
      return new RobotBouncer(pos);
    case 'drone':
      return new BassDrone(pos);
  }
}

/** Общие данные уровня, которые использует main.ts */
export interface LevelData {
  id: LevelId;
  title: string;
  spawn: THREE.Vector3;
  heading: number;
  zones: ZoneSpec[];
  finish: { pos: THREE.Vector3; radius: number } | null;
  ranks: RankThresholds;
  bpm: number;
  /** Расстояние до финиша от старта (для HUD) */
  length: number;
}

/** Текстуры и материалы треков (процедурные, 64×64) */
export interface TrackMaterials {
  floor: THREE.MeshLambertMaterial;
  escalator: THREE.MeshLambertMaterial;
  wall: THREE.MeshLambertMaterial;
  acid: THREE.MeshBasicMaterial;
  platform: THREE.MeshLambertMaterial;
  pillar: THREE.MeshLambertMaterial;
}

function canvas(draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) draw(g);
  return c;
}

export function makeTrackMaterials(): TrackMaterials {
  const floorTex = pixelTexture(
    canvas((g) => {
      g.fillStyle = '#120a22';
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#3a1a66';
      g.fillRect(0, 0, 64, 2);
      g.fillRect(0, 0, 2, 64);
      g.fillStyle = '#1e1436';
      g.fillRect(32, 32, 32, 32);
    }),
    8,
    8,
  );
  const escTex = pixelTexture(
    canvas((g) => {
      g.fillStyle = '#2a2a3a';
      g.fillRect(0, 0, 64, 64);
      for (let y = 0; y < 64; y += 8) {
        g.fillStyle = y % 16 === 0 ? '#505068' : '#33334a';
        g.fillRect(0, y, 64, 8);
      }
    }),
    1,
    6,
  );
  const wallTex = pixelTexture(
    canvas((g) => {
      g.fillStyle = '#1a1030';
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#ff00ff';
      g.fillRect(0, 30, 64, 4);
      g.fillStyle = '#00f0ff';
      g.fillRect(0, 8, 64, 2);
    }),
    4,
    2,
  );
  const acidMat = unlit(0x39ff14, 0.75, true);
  return {
    floor: createPS1Material({ color: 0xffffff, map: floorTex }),
    escalator: createPS1Material({ color: 0xffffff, map: escTex }),
    wall: createPS1Material({ color: 0xffffff, map: wallTex }),
    acid: acidMat,
    platform: lambert(0x2a2046),
    pillar: lambert(0x1a1a28),
  };
}

/**
 * TrackBuilder: линейная трасса из сегментов. Повороты кратны 90°, поэтому стены — AABB.
 * Каждый сегмент — Surface (физика) и меш (визуал); перила — TrickRail по точкам трассы.
 */
export class TrackBuilder {
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  /** Текущая дистанция по трассе (м) */
  dist = 0;
  private readonly group: THREE.Group;
  /** Записанные сегменты для перил: начало, направление, длина, наклон */
  private segs: { x: number; y: number; z: number; h: number; len: number; slope: number }[] = [];
  readonly materials: TrackMaterials;

  constructor(
    parent: THREE.Group,
    readonly col: Collider,
    readonly tricks: TrickObjects,
    readonly vfx: ClubVFX,
    materials: TrackMaterials,
  ) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.materials = materials;
  }

  /** Вектор «вперёд» по курсу (горизонтальный) */
  forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  right(): THREE.Vector3 {
    return new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
  }

  /** Поворот на ±90° (кратно 90° для AABB-стен) */
  turn(sign: 1 | -1): void {
    this.heading += (sign * Math.PI) / 2;
  }

  /** Точка на трассе с боковым смещением и высотой над полом */
  at(along: number, lat: number, height = 0): THREE.Vector3 {
    const f = this.forward();
    const r = this.right();
    return new THREE.Vector3(this.x + f.x * along + r.x * lat, this.y + height, this.z + f.z * along + r.z * lat);
  }

  /**
   * Сегмент пола: поверхность kind (floor/escalator/acid/platform), ширина, наклон (slope).
   * walls=true — боковые стены, пересекающиеся с коллайдером.
   */
  seg(len: number, opts: { width?: number; slope?: number; kind?: 'floor' | 'escalator' | 'acid' | 'platform'; walls?: boolean; dy?: number; wallH?: number } = {}): void {
    const width = opts.width ?? 14;
    const slope = opts.slope ?? 0;
    const kind = opts.kind ?? 'floor';
    const dy = opts.dy ?? 0;
    const yaw = this.heading + Math.PI;
    const origin = new THREE.Vector3(this.x, this.y + dy, this.z);
    const surf = new Surface({
      kind,
      tag: `${kind}-${this.dist.toFixed(0)}`,
      origin,
      yaw,
      slope,
      shape: { type: 'rect', u0: 0, u1: len, v0: -width / 2, v1: width / 2 },
    });
    this.col.surfaces.push(surf);

    // Визуал пола
    const geo = new THREE.PlaneGeometry(width, len);
    geo.rotateX(-Math.PI / 2);
    const mat = kind === 'escalator' ? this.materials.escalator : kind === 'acid' ? this.materials.acid : kind === 'platform' ? this.materials.platform : this.materials.floor;
    const mesh = new THREE.Mesh(geo, mat);
    const g = new THREE.Group();
    const f = this.forward();
    const mid = new THREE.Vector3(origin.x + f.x * (len / 2), origin.y + slope * (len / 2), origin.z + f.z * (len / 2));
    g.position.copy(mid);
    g.rotation.set(-Math.atan(slope), this.heading, 0, 'YXZ');
    g.add(mesh);
    if (kind === 'acid') mesh.position.y = 0.02;
    this.group.add(g);

    // Стены (AABB по углам сегмента)
    if (opts.walls) {
      const h = opts.wallH ?? 6;
      const r = this.right();
      const y0 = origin.y - 0.5;
      const corners = [
        new THREE.Vector3(origin.x, 0, origin.z),
        new THREE.Vector3(origin.x + f.x * len, 0, origin.z + f.z * len),
      ];
      for (const side of [-1, 1]) {
        const pts: THREE.Vector3[] = [];
        for (const c of corners) {
          pts.push(new THREE.Vector3(c.x + r.x * side * (width / 2 + 0.3), 0, c.z + r.z * side * (width / 2 + 0.3)));
          pts.push(new THREE.Vector3(c.x + r.x * side * (width / 2 + 1.3), 0, c.z + r.z * side * (width / 2 + 1.3)));
        }
        const minX = Math.min(...pts.map((p) => p.x));
        const maxX = Math.max(...pts.map((p) => p.x));
        const minZ = Math.min(...pts.map((p) => p.z));
        const maxZ = Math.max(...pts.map((p) => p.z));
        this.col.walls.push({ minX, maxX, minY: y0, maxY: y0 + h, minZ, maxZ });
        const box = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX, h, maxZ - minZ), this.materials.wall);
        box.position.set((minX + maxX) / 2, y0 + h / 2, (minZ + maxZ) / 2);
        this.group.add(box);
      }
    }

    this.segs.push({ x: this.x, y: this.y, z: this.z, h: this.heading, len, slope });
    this.advance(len, slope);
    this.dist += len;
  }

  /** Красный кикер/рампа: вылет по наклону slope (длина len по горизонтали) */
  ramp(len: number, width: number, slope: number, kind: 'ramp' | 'mega' = 'ramp'): void {
    const origin = new THREE.Vector3(this.x, this.y, this.z);
    this.tricks.addRamp(this.col, origin, this.heading + Math.PI, slope, len, width, kind);
    this.segs.push({ x: this.x, y: this.y, z: this.z, h: this.heading, len, slope });
    this.advance(len, slope);
    this.dist += len;
  }

  /** Перила: точки трассы на боковом смещении lat и высоте height, по записанным сегментам */
  rail(lat: number, height: number, fromSeg = 0, toSeg?: number): TrickRail {
    const pts: THREE.Vector3[] = [];
    const list = this.segs.slice(fromSeg, toSeg === undefined ? undefined : toSeg);
    for (const s of list) {
      const f = new THREE.Vector3(-Math.sin(s.h), 0, -Math.cos(s.h));
      const r = new THREE.Vector3(Math.cos(s.h), 0, -Math.sin(s.h));
      const steps = Math.max(2, Math.ceil(s.len / 6));
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * s.len;
        pts.push(new THREE.Vector3(s.x + f.x * t + r.x * lat, s.y + s.slope * t + height, s.z + f.z * t + r.z * lat));
      }
    }
    return this.tricks.addRail(pts, false, true);
  }

  /** Записать текущий сегмент: для перил после рамп и поворотов */
  markSegment(): number {
    return this.segs.length;
  }

  private advance(len: number, slope: number): void {
    const f = this.forward();
    this.x += f.x * len;
    this.z += f.z * len;
    this.y += slope * len;
  }

  /** Боковой вход/выход из трассы: координаты для спавна и финиша */
  place(x: number, y: number, z: number, heading: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.heading = heading;
  }

  /** Декорация: колонны по обе стороны трассы */
  pillars(count: number, step: number, lat: number, from = 0): void {
    for (let i = 0; i < count; i++) {
      const p = this.at(from + i * step, lat, 0);
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 6, 0.8), this.materials.pillar);
      m.position.set(p.x, p.y + 3, p.z);
      this.group.add(m);
    }
  }

  /** Вывеска над трассой с текстом (баннер ClubVFX) */
  sign(text: string, hex: number, along: number, height = 5.5): void {
    const p = this.at(along, 0, height);
    const b = this.vfx.makeBanner(text, hex, 14, 3);
    b.position.copy(p);
    b.rotation.y = this.heading;
    this.group.add(b);
  }

  /** Арка финиша: два столба и баннер; возвращает центр для проверки */
  finishArch(along: number): THREE.Vector3 {
    const p = this.at(along, 0, 0);
    const pillarMat = unlit(0xffe84a, 1, true);
    for (const s of [-1, 1]) {
      const pp = this.at(along, s * 7, 0);
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 9, 0.5), pillarMat);
      m.position.set(pp.x, pp.y + 4.5, pp.z);
      this.group.add(m);
    }
    const b = this.vfx.makeBanner('ФИНИШ', 0xffe84a, 14, 3);
    b.position.set(p.x, p.y + 8, p.z);
    b.rotation.y = this.heading;
    this.group.add(b);
    return new THREE.Vector3(p.x, p.y + 3, p.z);
  }

  /** Красные ворота портала: двойные перила и баннер (для финиша в боссе используется отдельно) */
  get root(): THREE.Group {
    return this.group;
  }
}

/** Пустой уровень: сбрасываем коллайдер и визуал перед загрузкой */
export function resetWorld(col: Collider, group: THREE.Group, tricks: TrickObjects): void {
  col.surfaces.length = 0;
  col.walls.length = 0;
  col.bound = null;
  group.clear();
  tricks.clearGroup();
}

/** Утилита: спавн-спец по относительным координатам трассы */
function spawnAt(b: TrackBuilder, type: EnemyType, along: number, lat: number, dy = 0): SpawnSpec {
  const p = b.at(along, lat, dy);
  return { type, x: p.x, y: p.y, z: p.z };
}

/** Зона-триггер: спавн при входе игрока в радиус */
function zoneAt(b: TrackBuilder, id: string, along: number, lat: number, radius: number, spawns: SpawnSpec[]): ZoneSpec {
  const p = b.at(along, lat, 0);
  return { id, x: p.x, z: p.z, radius, spawns };
}

/**
 * Уровень 1: «Метрополитен и фейс-контроль» (~385 м): перрон, эскалатор, турникеты, гардероб и мега-рампа.
 */
export function buildLevel1(scene: THREE.Group, col: Collider, tricks: TrickObjects, vfx: ClubVFX, mats: TrackMaterials): LevelData {
  const b = new TrackBuilder(scene, col, tricks, vfx, mats);
  b.place(0, 0, 0, 0);
  const zones: ZoneSpec[] = [];

  // Секция 1: перрон метро, двойные перила по центру
  const s1 = b.markSegment();
  zones.push(zoneAt(b, 'z1a', 20, 0, 18, [spawnAt(b, 'raver', 40, -3), spawnAt(b, 'raver', 46, 3), spawnAt(b, 'raver', 60, 0)]));
  b.seg(70, { width: 14, walls: true });
  b.rail(-1.6, 0.9, s1);
  b.rail(1.6, 0.9, s1);
  b.sign('МЕТРО: ПЕРРОН', 0xff00ff, 6);
  b.pillars(10, 14, -6.5, 4);
  b.pillars(10, 14, 6.5, 4);

  // Секция 2: гигантский эскалатор вниз, три балюстрады
  const s2 = b.markSegment();
  zones.push(zoneAt(b, 'z2a', 30, 0, 22, [spawnAt(b, 'drone', 40, -3, 4.5), spawnAt(b, 'drone', 55, 3, 4.5), spawnAt(b, 'raver', 60, 0)]));
  zones.push(zoneAt(b, 'z2b', 50, 0, 20, [spawnAt(b, 'sniper', 52, -5), spawnAt(b, 'drone', 58, 0, 4.5)]));
  b.seg(70, { width: 16, slope: -0.22, kind: 'escalator', walls: true });
  b.rail(-4.5, 0.95, s2);
  b.rail(0, 0.95, s2);
  b.rail(4.5, 0.95, s2);

  // Секция 3: турникеты и кикеры, роботы-вышибалы
  const s3 = b.markSegment();
  zones.push(zoneAt(b, 'z3a', 20, 0, 22, [spawnAt(b, 'robot', 40, 0), spawnAt(b, 'raver', 50, -4), spawnAt(b, 'raver', 50, 4)]));
  zones.push(zoneAt(b, 'z3b', 62, 0, 24, [spawnAt(b, 'robot', 72, -6), spawnAt(b, 'sniper', 80, 6), spawnAt(b, 'drone', 70, 0, 5)]));
  b.seg(50, { width: 26, walls: true });
  for (let i = 0; i < 3; i++) {
    b.seg(10, { width: 26, walls: true });
    b.ramp(5, 6, 0.3);
    b.seg(6, { width: 26, slope: -0.3, walls: true });
  }
  b.rail(-6, 0.9, s3);
  b.rail(6, 0.9, s3);
  b.sign('ТУРНИКЕТЫ', 0xff0033, 10);

  // Секция 4: гардероб, поворот, длинный финальный ряд и мега-рампа в арку «ФИНИШ»
  const s4 = b.markSegment();
  b.turn(1);
  zones.push(zoneAt(b, 'z4a', 30, 0, 24, [spawnAt(b, 'raver', 45, -5), spawnAt(b, 'raver', 45, 5), spawnAt(b, 'robot', 55, 0), spawnAt(b, 'sniper', 62, 7)]));
  zones.push(zoneAt(b, 'z4b', 62, 0, 24, [spawnAt(b, 'drone', 76, -4, 4.5), spawnAt(b, 'drone', 76, 4, 4.5), spawnAt(b, 'raver', 86, 0)]));
  b.seg(90, { width: 22, walls: true });
  b.rail(-7, 0.9, s4);
  b.rail(7, 0.9, s4);
  b.seg(20, { width: 22, walls: true });
  b.ramp(12, 10, 0.35, 'mega');
  b.seg(10, { width: 22, walls: false });
  b.sign('ГАРДЕРОБ', 0x39ff14, 40);

  const finishPos = b.finishArch(10);
  const endZ = b.dist;
  return {
    id: 1,
    title: 'УРОВЕНЬ 1: МЕТРО И ФЕЙС-КОНТРОЛЬ',
    spawn: new THREE.Vector3(0, 0.1, -3),
    heading: 0,
    zones,
    finish: { pos: finishPos, radius: 7 },
    ranks: { S: 60000, A: 40000, B: 20000, C: 8000 },
    bpm: 190,
    length: Math.round(endZ),
  };
}

/**
 * Уровень 2: «Кислотный цех и VIP-ложи» (~450 м): S-рельсы, кислотные чаны, балкон и туннель сабвуферов.
 */
export function buildLevel2(scene: THREE.Group, col: Collider, tricks: TrickObjects, vfx: ClubVFX, mats: TrackMaterials): LevelData {
  const b = new TrackBuilder(scene, col, tricks, vfx, mats);
  b.place(0, 0, 0, 0);
  const zones: ZoneSpec[] = [];

  // Секция 1: нижний рейв-коридор с S-образными перилами
  const s1 = b.markSegment();
  zones.push(zoneAt(b, 'y1a', 25, 0, 20, [spawnAt(b, 'raver', 40, -3), spawnAt(b, 'raver', 50, 3), spawnAt(b, 'drone', 60, 0, 4.5)]));
  b.seg(40, { width: 12, walls: true });
  const sStart = b.markSegment();
  for (let i = 0; i < 4; i++) {
    b.turn(i % 2 === 0 ? 1 : -1);
    b.seg(18, { width: 12, walls: true });
  }
  b.rail(-2.2, 1.0, sStart);
  b.rail(2.2, 1.0, sStart);
  b.sign('СТРОБЫ', 0x00f0ff, 10);

  // Секция 2: кислотные чаны — прыжки с рамп над зелёными ямами
  b.turn(-1);
  const s2 = b.markSegment();
  zones.push(zoneAt(b, 'y2a', 40, 0, 24, [spawnAt(b, 'drone', 60, -4, 4.5), spawnAt(b, 'drone', 70, 4, 4.5), spawnAt(b, 'robot', 75, 0)]));
  for (let i = 0; i < 3; i++) {
    b.seg(10, { width: 14, walls: false });
    b.ramp(6, 14, 0.35);
    b.seg(10, { width: 14, kind: 'acid', dy: -1.5, walls: false });
  }
  b.seg(10, { width: 14, walls: false });
  b.rail(-4, 4.2, s2, s2 + 1);
  b.rail(4, 4.2, s2, s2 + 1);
  b.sign('КИСЛОТА', 0x39ff14, 25, 6.5);

  // Секция 3: двухъярусный VIP-зал — рампа на балкон
  b.turn(1);
  const s3 = b.markSegment();
  zones.push(zoneAt(b, 'y3a', 15, 0, 22, [spawnAt(b, 'sniper', 40, -4, 6.5), spawnAt(b, 'sniper', 45, 4, 6.5)]));
  zones.push(zoneAt(b, 'y3b', 50, 0, 22, [spawnAt(b, 'sniper', 56, -5, 6.5), spawnAt(b, 'raver', 64, 0, 6.5), spawnAt(b, 'robot', 46, 0)]));
  b.seg(14, { width: 16, walls: true });
  b.ramp(14, 14, 0.45);
  const balcony = b.markSegment();
  b.seg(60, { width: 16, walls: true });
  b.rail(-6.5, 1.0, balcony);
  b.rail(6.5, 1.0, balcony);
  b.seg(14, { width: 16, slope: -0.45, walls: true });
  b.rail(-5, 0.9, s3);
  b.sign('VIP', 0xff00ff, 35);

  // Секция 4: туннель сабвуферов с лазерами и вылет в финал
  const s4 = b.markSegment();
  zones.push(zoneAt(b, 'y4a', 40, 0, 26, [spawnAt(b, 'raver', 55, -4), spawnAt(b, 'raver', 55, 4), spawnAt(b, 'drone', 65, 0, 4.5), spawnAt(b, 'sniper', 70, 0)]));
  zones.push(zoneAt(b, 'y4b', 110, 0, 26, [spawnAt(b, 'robot', 120, -5), spawnAt(b, 'raver', 124, 5), spawnAt(b, 'drone', 130, 0, 4.5)]));
  b.seg(130, { width: 12, walls: true });
  b.rail(-3, 0.9, s4);
  b.rail(3, 0.9, s4);
  const laserPos = b.at(60, 0, 5);
  vfx.addLaserRig(scene, laserPos, 4);
  b.seg(20, { width: 12, walls: true });
  b.ramp(12, 10, 0.35, 'mega');
  b.seg(10, { width: 12, walls: false });
  b.sign('ФИНИШ', 0xffe84a, 30);

  const finishPos = b.finishArch(10);
  return {
    id: 2,
    title: 'УРОВЕНЬ 2: КИСЛОТНЫЙ VIP-ЦЕХ',
    spawn: new THREE.Vector3(0, 0.1, -3),
    heading: 0,
    zones,
    finish: { pos: finishPos, radius: 7 },
    ranks: { S: 80000, A: 55000, B: 30000, C: 12000 },
    bpm: 190,
    length: Math.round(b.dist),
  };
}

/**
 * Арена босса (Уровень 3): круг r=48 м, кольцевые перила, 6 радиальных рамп, 4 рампы на платформы, 3 пилона, стадия с боссом и мега-рампа.
 * Возвращает данные уровня и ссылки для BossDJArchon.
 */
export interface BossArena {
  data: LevelData;
  boss: BossDJArchon;
  megaRamp: { surface: Surface; group: THREE.Group };
  pylons: THREE.Vector3[];
  platforms: Surface[];
}

export function buildBossArena(
  scene: THREE.Group,
  col: Collider,
  tricks: TrickObjects,
  vfx: ClubVFX,
  mats: TrackMaterials,
  callbacks: {
    onSay: (t: string) => void;
    onPhase: (p: BossPhase) => void;
    onBpm: (b: number) => void;
    onDefeat: () => void;
    onSpawn: (t: EnemyType, p: THREE.Vector3) => void;
    onShieldBreak: () => void;
    onElectric: (on: boolean) => void;
    scene: THREE.Scene;
  },
): BossArena {
  const R = 48;
  col.bound = { cx: 0, cz: 0, r: R };
  // Пол арены
  const floor = new Surface({ kind: 'floor', origin: new THREE.Vector3(0, 0, 0), shape: { type: 'circle', r: R } });
  col.surfaces.push(floor);
  const floorMesh = new THREE.Mesh(new THREE.CircleGeometry(R, 48), mats.floor);
  floorMesh.rotation.x = -Math.PI / 2;
  scene.add(floorMesh);

  // Кольцевые перила: внешнее (r=40) и среднее (r=26) кольцо
  const ring = (r: number, h: number): THREE.Vector3[] => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, h, Math.sin(a) * r));
    }
    return pts;
  };
  tricks.addRail(ring(40, 0.9), true, true);
  tricks.addRail(ring(26, 0.9), true, true);
  // Верхнее кольцо над платформами (фаза 2)
  tricks.addRail(ring(26, 5.6), true, true);

  // 6 радиальных рамп (наружу) для бесконечного разгона по кругу
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const o = new THREE.Vector3(Math.cos(a) * 27, 0, Math.sin(a) * 27);
    // Выход наружу: U направлен от центра, U = (sin yaw, cos yaw)
    const yaw = Math.atan2(Math.cos(a), Math.sin(a));
    tricks.addRamp(col, o, yaw, 0.35, 8, 4, 'ramp');
  }

  // 4 рампы внутрь на платформы (фаза 2) и сами платформы
  const platforms: Surface[] = [];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
    const o = new THREE.Vector3(Math.cos(a) * 40, 0, Math.sin(a) * 40);
    const inward = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a));
    const yaw = Math.atan2(inward.x, inward.z);
    tricks.addRamp(col, o, yaw, 0.5, 8, 6, 'ramp');
    // Платформы радиально вдоль внутреннего кольца
    const pa = a;
    for (const off of [-0.18, 0.18]) {
      const pa2 = pa + off;
      const pc = new THREE.Vector3(Math.cos(pa2) * 28, 4, Math.sin(pa2) * 28);
      const pf = new Surface({ kind: 'platform', origin: pc, shape: { type: 'circle', r: 4 } });
      col.surfaces.push(pf);
      platforms.push(pf);
      const pm = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 4, 14), mats.platform);
      pm.position.set(pc.x, 2, pc.z);
      scene.add(pm);
    }
  }

  // Стадия босса на севере: платформа высотой 2.5 м
  const stageC = new THREE.Vector3(0, 2.5, -38);
  const stage = new Surface({ kind: 'platform', origin: stageC, shape: { type: 'circle', r: 10 } });
  col.surfaces.push(stage);
  const stageMesh = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 2.5, 24), mats.platform);
  stageMesh.position.set(0, 1.25, -38);
  scene.add(stageMesh);

  // Мега-рампа от центра к стадии (скрыта до фазы 3)
  const megaGroup = new THREE.Group();
  scene.add(megaGroup);
  const megaOrigin = new THREE.Vector3(0, 0, -20);
  const megaRes = tricks.addRamp(col, megaOrigin, Math.PI, 0.25, 10, 8, 'mega', 'mega');
  megaRes.surface.enabled = false;
  megaGroup.add(megaRes.group);
  megaGroup.scale.y = 0.001;
  // Рампу держим видимой, но выключенной в физике до фазы 3
  megaGroup.visible = true;

  // Пилоны на кольцевых перилах
  const pylons = [new THREE.Vector3(-22, 0, -30), new THREE.Vector3(22, 0, -30), new THREE.Vector3(0, 0, 34)];

  const boss = new BossDJArchon({
    pos: new THREE.Vector3(0, 2.5, -40),
    pylons,
    platforms,
    megaRamp: { surface: megaRes.surface, group: megaGroup },
    onSay: callbacks.onSay,
    onPhase: callbacks.onPhase,
    onBpm: callbacks.onBpm,
    onDefeat: callbacks.onDefeat,
    onSpawn: callbacks.onSpawn,
    onShieldBreak: callbacks.onShieldBreak,
    onElectric: callbacks.onElectric,
    scene: callbacks.scene,
  });
  scene.add(boss.group);

  // Клуб: лазеры и стробы арены
  vfx.addLaserRig(scene, new THREE.Vector3(0, 16, 0), 6);
  vfx.addLaserRig(scene, new THREE.Vector3(0, 16, -30), 4);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    vfx.placeStrobe(i, new THREE.Vector3(Math.cos(a) * 30, 14, Math.sin(a) * 30), 0x00ffcc);
  }

  // Зоны спавна: начальные враги
  const zones: ZoneSpec[] = [
    {
      id: 'arena-start',
      x: 0,
      z: 26,
      radius: 22,
      spawns: [
        { type: 'raver', x: -6, y: 0, z: 22 },
        { type: 'raver', x: 6, y: 0, z: 22 },
        { type: 'drone', x: 0, y: 4, z: 20 },
        { type: 'robot', x: -12, y: 0, z: 14 },
      ],
    },
  ];

  return {
    data: {
      id: 3,
      title: 'ФИНАЛ: БОСС DJ АРХОНТ-909',
      spawn: new THREE.Vector3(0, 0.1, 40),
      heading: 0,
      zones,
      finish: null,
      ranks: { S: 120000, A: 80000, B: 40000, C: 15000 },
      bpm: 190,
      length: 0,
    },
    boss,
    megaRamp: { surface: megaRes.surface, group: megaGroup },
    pylons,
    platforms,
  };
}
