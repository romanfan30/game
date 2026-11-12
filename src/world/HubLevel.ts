import * as THREE from 'three';
import { createPS1Material, lambert, pixelTexture, unlit } from '../shaders/PS1Material';
import { buildRaver, Rig } from '../enemies/EnemyModels';
import { DamageInfo, LevelId, LevelRecord, Targetable } from '../types';
import { ClubVFX } from './ClubVFX';
import { Collider } from './Collider';
import { TrackMaterials } from './LevelBuilder';
import { TrickObjects } from './TrickObjects';

export const HUB_HALF = 23;
export const CUSTOM_ZONE = new THREE.Vector2(-16, 0);
export const CUSTOM_RADIUS = 2.8;
export const BOARD_POS = new THREE.Vector3(16, 0, -6);

export interface Portal {
  level: LevelId;
  pos: THREE.Vector3;
  radius: number;
  label: string;
  hex: number;
  glow: THREE.MeshBasicMaterial;
}

/** Манекен ТЕСТОВЫЙ РЕПТИЛОИД: пружинит, по смерти взрывается конфетти и возрождается через 1.5 с */
export class TestDummy implements Targetable {
  readonly id = 77001;
  readonly radius = 0.6;
  alive = true;
  readonly group = new THREE.Group();
  private readonly rig: Rig;
  private hp = 45;
  private respawnT = -1;
  private t = 0;
  onDown: ((d: TestDummy) => void) | null = null;

  constructor(private readonly vfx: ClubVFX, private readonly pos: THREE.Vector3) {
    this.rig = buildRaver();
    this.group.add(this.rig.root);
    this.group.position.copy(pos);
    this.group.rotation.y = Math.PI / 2;
  }

  getCenter(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.group.position.x, this.group.position.y + 0.9, this.group.position.z);
  }

  isWeakPoint(p: THREE.Vector3): boolean {
    return p.y > this.group.position.y + 1.25;
  }

  damage(info: DamageInfo): boolean {
    if (!this.alive) return false;
    this.hp -= info.amount;
    if (this.hp > 0) {
      this.rig.body.rotation.x = 0.25;
      return false;
    }
    this.alive = false;
    this.respawnT = 1.5;
    this.group.visible = false;
    const c = this.getCenter(new THREE.Vector3());
    const colors = [0xff00ff, 0x00f0ff, 0xffe84a, 0x39ff14, 0xff0033];
    for (const col of colors) this.vfx.burst(c, col, 24, 10, 1.0, 0.16, 6);
    this.onDown?.(this);
    return true;
  }

  update(dt: number): void {
    this.t += dt;
    if (!this.alive) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) {
        this.alive = true;
        this.hp = 45;
        this.group.visible = true;
      }
      return;
    }
    // Пружинящая поза: корпус качается, руки в такт
    this.rig.body.rotation.x += (0 - this.rig.body.rotation.x) * Math.min(1, dt * 6);
    this.rig.body.position.y = Math.sin(this.t * 4) * 0.04;
    this.rig.armL.rotation.x = Math.sin(this.t * 3) * 0.3;
    this.rig.armR.rotation.x = -Math.sin(this.t * 3) * 0.3;
    this.group.position.y = this.pos.y;
  }
}

/** Табло рекордов: рисуется на CanvasTexture (ранги S/A/B/C/D) */
function drawBoard(records: Record<'1' | '2' | '3', LevelRecord | null>): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  if (!g) return c;
  g.fillStyle = '#0c0816';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#ffe84a';
  g.font = 'bold 18px monospace';
  g.fillText('РЕКОРДЫ', 84, 22);
  const rows: [string, '1' | '2' | '3'][] = [
    ['УР.1 МЕТРО', '1'],
    ['УР.2 КИСЛОТА', '2'],
    ['ФИНАЛ БОСС', '3'],
  ];
  g.font = '14px monospace';
  rows.forEach(([name, id], i) => {
    const r = records[id];
    g.fillStyle = '#ff00ff';
    g.fillText(name, 14, 52 + i * 26);
    g.fillStyle = r ? '#39ff14' : '#666680';
    g.fillText(r ? `${r.score.toString().padStart(7, '0')}  [${r.rank}]` : '--- НЕТ ---', 130, 52 + i * 26);
  });
  return c;
}

/**
 * HubLevel: «Подсобка и гримёрка клуба» 46×46 м — рельсы, рампы, манекен, табло, верстак кастомизации и 3 портала.
 */
export class HubLevel {
  readonly group = new THREE.Group();
  readonly portals: Portal[] = [];
  readonly dummy: TestDummy;
  private boardMat: THREE.MeshBasicMaterial;
  private readonly boardCanvas: HTMLCanvasElement;
  private readonly boardTex: THREE.CanvasTexture;
  private readonly customRing: THREE.MeshBasicMaterial;
  private readonly spawn = new THREE.Vector3(0, 0.1, 8);

  constructor(parent: THREE.Group, col: Collider, tricks: TrickObjects, vfx: ClubVFX, mats: TrackMaterials, records: Record<'1' | '2' | '3', LevelRecord | null>) {
    parent.add(this.group);
    const H = HUB_HALF;
    col.bound = null;
    col.surfaces.length = 0;
    col.walls.length = 0;
    // Пол и стены
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, H * 2), mats.floor);
    floor.rotation.x = -Math.PI / 2;
    this.group.add(floor);
    const wallMat = mats.wall;
    const wallDefs: [number, number, number, number, number, number][] = [
      [-H - 0.5, H + 0.5, 0, 9, -H - 0.5, -H + 0.5],
      [-H - 0.5, H + 0.5, 0, 9, H - 0.5, H + 0.5],
      [-H - 0.5, -H + 0.5, 0, 9, -H - 0.5, H + 0.5],
      [H - 0.5, H + 0.5, 0, 9, -H - 0.5, H + 0.5],
    ];
    for (const [minX, maxX, minY, maxY, minZ, maxZ] of wallDefs) {
      col.walls.push({ minX, maxX, minY, maxY, minZ, maxZ });
      const box = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ), wallMat);
      box.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      this.group.add(box);
    }

    // Колонны с неоновыми полосами
    const neon = unlit(0x00f0ff, 1, true);
    for (const [x, z] of [
      [-12, -12],
      [12, -12],
      [-12, 12],
      [12, 12],
    ]) {
      const colm = new THREE.Mesh(new THREE.BoxGeometry(1.6, 9, 1.6), lambert(0x1e1a34));
      colm.position.set(x, 4.5, z);
      this.group.add(colm);
      col.walls.push({ minX: x - 0.8, maxX: x + 0.8, minY: 0, maxY: 9, minZ: z - 0.8, maxZ: z + 0.8 });
      const strip = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.2, 1.7), neon);
      strip.position.set(x, 6, z);
      this.group.add(strip);
    }

    // Граффити на задней стене (процедурный CanvasTexture)
    const gc = document.createElement('canvas');
    gc.width = 128;
    gc.height = 64;
    const gg = gc.getContext('2d');
    if (gg) {
      gg.fillStyle = '#140a26';
      gg.fillRect(0, 0, 128, 64);
      gg.fillStyle = '#ff00ff';
      gg.font = 'bold 26px monospace';
      gg.fillText('GABBER', 8, 34);
      gg.fillStyle = '#39ff14';
      gg.font = 'bold 18px monospace';
      gg.fillText('1999 ★', 22, 58);
    }
    const graff = new THREE.Mesh(new THREE.PlaneGeometry(10, 5), createPS1Material({ color: 0xffffff, map: pixelTexture(gc, 1, 1) }));
    graff.position.set(-6, 4.5, -H + 0.6);
    this.group.add(graff);

    // Длинные изогнутые перила вдоль центра и две рампы друг напротив друга
    const arc: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI;
      arc.push(new THREE.Vector3(Math.cos(a) * 5 + 2, 0.9, Math.sin(a) * 5 + 2));
    }
    tricks.addRail(arc, false, true);
    tricks.addRail([new THREE.Vector3(-4, 0.9, 12), new THREE.Vector3(4, 0.9, 12)], false, true);
    tricks.addRamp(col, new THREE.Vector3(-6, 0, 16), Math.PI * 0.25, 0.3, 5, 6, 'ramp');
    tricks.addRamp(col, new THREE.Vector3(6, 0, 16), -Math.PI * 0.25, 0.3, 5, 6, 'ramp');

    // Манекен
    this.dummy = new TestDummy(vfx, new THREE.Vector3(-2, 0, -8));
    this.group.add(this.dummy.group);

    // Верстак кастомизации: циановый круг
    const ringGeo = new THREE.RingGeometry(CUSTOM_RADIUS - 0.25, CUSTOM_RADIUS, 32);
    this.customRing = unlit(0x00f0ff, 0.9, true);
    const ring = new THREE.Mesh(ringGeo, this.customRing);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(CUSTOM_ZONE.x, 0.05, CUSTOM_ZONE.y);
    this.group.add(ring);
    const bench = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 1.2), lambert(0x222238));
    bench.position.set(CUSTOM_ZONE.x, 0.55, CUSTOM_ZONE.y - 2.2);
    this.group.add(bench);
    const banner1 = vfx.makeBanner('ВЕРСТАК КАСТОМИЗАЦИИ', 0x00f0ff, 10, 2.4);
    banner1.position.set(CUSTOM_ZONE.x, 4.2, CUSTOM_ZONE.y);
    banner1.rotation.y = Math.PI / 2;
    this.group.add(banner1);

    // Табло рекордов: жёлтый стенд у стены
    this.boardCanvas = drawBoard(records);
    this.boardTex = pixelTexture(this.boardCanvas, 1, 1);
    this.boardMat = new THREE.MeshBasicMaterial({ map: this.boardTex });
    const stand = new THREE.Mesh(new THREE.BoxGeometry(5, 3.2, 0.6), lambert(0xffe84a, 0xffe84a, 0.2));
    stand.position.set(BOARD_POS.x, 2, BOARD_POS.z);
    this.group.add(stand);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.6), this.boardMat);
    screen.position.set(BOARD_POS.x - 0.05, 2.1, BOARD_POS.z + 0.33);
    this.group.add(screen);
    const label = vfx.makeBanner('ТАБЛО РЕКОРДОВ', 0xffe84a, 8, 1.6);
    label.position.set(BOARD_POS.x, 4.4, BOARD_POS.z);
    this.group.add(label);

    // Три портала на дальней стене (z = -21): 1 — метро, 2 — кислота, 3 — финал
    const portalDefs: { level: LevelId; x: number; label: string; hex: number }[] = [
      { level: 1, x: -12, label: 'УРОВЕНЬ 1: МЕТРО И ФЕЙС-КОНТРОЛЬ', hex: 0x00f0ff },
      { level: 2, x: 0, label: 'УРОВЕНЬ 2: КИСЛОТНЫЙ VIP-ЦЕХ', hex: 0x39ff14 },
      { level: 3, x: 12, label: 'ФИНАЛ: БОСС DJ АРХОНТ-909', hex: 0xff00ff },
    ];
    for (const pd of portalDefs) {
      const z = -21;
      const glow = new THREE.MeshBasicMaterial({ color: pd.hex, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
      const frameMat = createPS1Material({ color: 0xffffff, emissive: pd.hex, emissiveIntensity: 1 });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 6.2), glow);
      plane.position.set(pd.x, 3.1, z + 0.2);
      this.group.add(plane);
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6.4, 0.4), frameMat);
        post.position.set(pd.x + sx * 2.5, 3.2, z + 0.2);
        this.group.add(post);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.4, 0.4), frameMat);
      top.position.set(pd.x, 6.5, z + 0.2);
      this.group.add(top);
      const ban = vfx.makeBanner(pd.label, pd.hex, 9, 1.6);
      ban.position.set(pd.x, 7.6, z + 0.3);
      this.group.add(ban);
      // Красный трамплин перед порталом
      tricks.addRamp(col, new THREE.Vector3(pd.x - 1.6, 0, -12), Math.PI, 0.3, 5, 4, 'ramp');
      this.portals.push({ level: pd.level, pos: new THREE.Vector3(pd.x, 0, z), radius: 2.4, label: pd.label, hex: pd.hex, glow });
    }
    this.highlightNext(1);
  }

  spawnPoint(): THREE.Vector3 {
    return this.spawn.clone();
  }

  /** Обновить табло рекордов после победы */
  updateBoard(records: Record<'1' | '2' | '3', LevelRecord | null>): void {
    const dst = this.boardCanvas.getContext('2d');
    if (dst) {
      dst.clearRect(0, 0, this.boardCanvas.width, this.boardCanvas.height);
      dst.drawImage(drawBoard(records), 0, 0);
    }
    this.boardTex.needsUpdate = true;
  }

  /** Подсветка «СЛЕДУЮЩИЙ ЗАЕЗД»: яркий портал следующего уровня */
  highlightNext(level: LevelId): void {
    for (const p of this.portals) {
      p.glow.opacity = p.level === level ? 0.75 : 0.25;
    }
  }

  /** Анимация хаба: пульс неона и табло */
  update(dt: number, time: number): void {
    this.customRing.opacity = 0.5 + Math.sin(time * 4) * 0.35;
    this.dummy.update(dt);
    this.boardMat.color.setScalar(0.9 + Math.sin(time * 2) * 0.1);
  }
}
