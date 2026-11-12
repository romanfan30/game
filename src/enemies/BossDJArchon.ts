import * as THREE from 'three';
import { createPS1Material, lambert, pixelTexture, unlit } from '../shaders/PS1Material';
import { DamageInfo, EnemyType, Targetable } from '../types';
import { Enemy, EnemyEnv } from '../combat/EnemyManager';
import { Surface } from '../world/Collider';
import { ClubVFX } from '../world/ClubVFX';
import { Rig } from './EnemyModels';

export const BOSS_HP = 2500;
const PYLON_HP = 220;
const ELECTRIC_PERIOD = 10;
const ELECTRIC_WARN = 1.5;
const ELECTRIC_ACTIVE = 6;
const ELECTRIC_DPS = 12;

/** Басовый пилон: цель, прикрывающая щит босса */
export class BassPylon implements Targetable {
  readonly id: number;
  readonly radius = 1.2;
  alive = true;
  private hp = PYLON_HP;
  readonly group = new THREE.Group();
  private readonly lamp: THREE.Mesh;
  private readonly lampMat: THREE.MeshBasicMaterial;
  private t = Math.random() * 6;

  constructor(id: number, pos: THREE.Vector3, private readonly onDown: (p: BassPylon) => void) {
    this.id = id;
    this.group.position.copy(pos);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, 6, 8), lambert(0x222230));
    body.position.y = 3;
    this.group.add(body);
    const speakerMat = createPS1Material({ color: 0xffffff, map: pixelTexture(this.speakerCanvas(), 1, 2) });
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.4, 8), speakerMat);
    sp.position.y = 5;
    this.group.add(sp);
    this.lampMat = unlit(0xff0033, 1, true);
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), this.lampMat);
    this.lamp.position.y = 7.2;
    this.group.add(this.lamp);
  }

  private speakerCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    if (g) {
      g.fillStyle = '#101018';
      g.fillRect(0, 0, 64, 64);
      g.strokeStyle = '#ff0033';
      g.lineWidth = 4;
      for (let r = 8; r < 34; r += 8) {
        g.beginPath();
        g.arc(32, 32, r, 0, Math.PI * 2);
        g.stroke();
      }
    }
    return c;
  }

  getCenter(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.group.position.x, this.group.position.y + 4, this.group.position.z);
  }

  isWeakPoint(): boolean {
    return false;
  }

  damage(info: DamageInfo): boolean {
    if (!this.alive) return false;
    this.hp -= info.amount;
    if (this.hp <= 0) {
      this.alive = false;
      this.lampMat.color.setHex(0x222222);
      this.onDown(this);
      return true;
    }
    return false;
  }

  update(dt: number): void {
    this.t += dt;
    this.lampMat.color.setHex(this.alive ? (Math.floor(this.t * 6) % 2 === 0 ? 0xff0033 : 0x550011) : 0x222222);
  }
}

/** Бас-щит — полупрозрачный купол над боссом, снимается при уничтожении всех пилонов */
interface Laser {
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  speed: number;
}

/** Фазы босса */
export type BossPhase = 1 | 2 | 3;

export interface BossOptions {
  pos: THREE.Vector3;
  pylons: THREE.Vector3[];
  platforms: Surface[];
  megaRamp: { surface: Surface; group: THREE.Group };
  onSay: (text: string) => void;
  onPhase: (phase: BossPhase) => void;
  onBpm: (bpm: number) => void;
  onDefeat: () => void;
  onSpawn: (type: EnemyType, pos: THREE.Vector3) => void;
  onShieldBreak: () => void;
  onElectric: (on: boolean) => void;
  scene: THREE.Scene;
}

const SAY_START = 'ЙОУ, СМОТРИТЕ, КАКОЙ-ТО ЧЕЛ НА ДОСКЕ ПРИПЁРСЯ! АРХОНТ, ВРУБАЙ МЯСОРУБКУ!';
const SAY_P2 = 'ХВАТИТ КАТАТЬСЯ ПО МОЕМУ ТАНЦПОЛУ! ЗАЛИВАЙ ПОЛ ЭЛЕКТРО-ЖИЖЕЙ!';
const SAY_P3 = 'ДА КТО ТЫ ВОИМЯ НИБИРУ ТАКОЙ?! ВРУБАЮ 220 БПМ СПИДКОР!';
const SAY_DEAD = 'МОЙ РЕЙВ ОТМЕНИЛИИИИ!';
const BANTER = ['ЧЕЛ, ТЫ ВООБЩЕ ЧУВСТВУЕШЬ БАС?!', 'ЯЩЕРЫ, ВЫХОДИТЕ НА ПЛАТФОРМЫ!', 'ГАББЕР НЕ ОСТАНОВИТЬ!', 'ТЫ ЛОМАЕШЬ МОЙ ЩИТ, БРАТАН!'];

/**
 * BossDJArchon: DJ АРХОНТ-909 (12 м) и МС ГИГА-ЯЩЕР на плече.
 * Фаза 1: щит с 3 пилонами, лазеры и диско-сферы; ядро ×2.
 * Фаза 2: электропол 10-секундным циклом, платформы с врагами.
 * Фаза 3: 220 BPM, выдвижная мега-рампа, нож 400 урона; при 0 HP — slow-mo и фейерверк.
 */
export class BossDJArchon extends Enemy {
  readonly type = 'robot' as const;
  readonly deathColor = 0xff00ff;
  readonly centerY = 6.5;
  phase: BossPhase = 1;
  dying = false;
  /** Для внешних систем: мёртвый босс с финальной анимацией */
  readonly pylons: BassPylon[] = [];
  readonly shieldMesh: THREE.Mesh;
  private readonly lasers: Laser[] = [];
  private readonly coreMesh: THREE.Mesh;
  private readonly crownMesh: THREE.Mesh;
  private readonly crownBaseY: number;
  private readonly fistL: THREE.Object3D;
  private readonly fistR: THREE.Object3D;
  private readonly vinyl: THREE.Mesh[] = [];
  private readonly lightBeam: THREE.Mesh;
  private shieldUp = true;
  private shieldBreakT = -1;
  private electricT = 0;
  private electricOn = false;
  private electricWarned = false;
  private shotT = 2;
  private spawnT = 6;
  private sayT = 9;
  private phase2Started = false;
  private phase3Started = false;
  private deathT = -1;
  private readonly opts: BossOptions;
  private time = 0;
  private hitSpark = 0;

  constructor(opts: BossOptions) {
    const rig = buildBoss();
    super(opts.pos, BOSS_HP, rig);
    this.opts = opts;
    this.group.rotation.y = Math.PI;
    this.group.position.copy(opts.pos);
    this.fistL = rig.extra.fistL;
    this.fistR = rig.extra.fistR;
    this.coreMesh = rig.extra.core as THREE.Mesh;
    this.crownMesh = rig.extra.crown as THREE.Mesh;
    this.crownBaseY = this.crownMesh.position.y;
    for (const v of ['vinylL', 'vinylR']) this.vinyl.push(rig.extra[v] as THREE.Mesh);
    this.lightBeam = rig.extra.beam as THREE.Mesh;
    this.coreMesh.visible = false;

    // Щит
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(7.5, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    this.shieldMesh.position.y = 6.5;
    this.group.add(this.shieldMesh);

    // Пилоны расставлены вдоль кольцевых перил арены (координаты в мире)
    opts.pylons.forEach((p, i) => {
      const py = new BassPylon(1000 + i, p, (pylon) => this.onPylonDown(pylon));
      this.pylons.push(py);
      opts.scene.add(py.group);
    });

    // Лазеры фазы 1: два длинных горизонтальных луча
    for (let i = 0; i < 2; i++) {
      const pivot = new THREE.Group();
      pivot.position.set(0, 1.0, 0);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 44), unlit(0x39ff14, 0.85, true));
      mesh.position.z = 22;
      pivot.add(mesh);
      pivot.rotation.y = i * Math.PI;
      pivot.visible = false;
      this.group.add(pivot);
      this.lasers.push({ pivot, mesh, speed: 0.5 + i * 0.2 });
    }
  }

  /** Все цели босса: тело, пилоны (в список менеджера добавляются отдельно) */
  /** Вызывается при попадании в тело босса */
  isWeakPoint(p: THREE.Vector3): boolean {
    if (this.shieldUp) return false;
    const c = this.getCenter(new THREE.Vector3());
    return p.distanceTo(c) < 2.4;
  }

  damage(info: DamageInfo): boolean {
    if (!this.alive || this.dying) return false;
    if (this.shieldUp) {
      this.hitSpark = 0.1;
      return false;
    }
    let amount = info.amount;
    if (info.method === 'knife' && this.phase === 3) amount = 400;
    // Ядро ×2 — только при точном прицеле (ПКМ); автонаводка по корпусу не даёт множитель
    if (info.headshot) amount *= 2;
    this.hp -= amount;
    this.flash = 0.12;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.dying = true;
      this.deathT = 0;
      return true;
    }
    return false;
  }

  /** Попадание по пилону: отдельный урон, без урона по HP босса */
  onPylonDown(p: BassPylon): void {
    const alive = this.pylons.filter((x) => x.alive).length;
    this.opts.onSay(`ПИЛОН ${p.id - 999} ПОГАС! ОСТАЛОСЬ ${alive}`);
    if (alive === 0) this.breakShield();
  }

  private breakShield(): void {
    this.shieldUp = false;
    this.shieldBreakT = 0;
    this.coreMesh.visible = true;
    this.opts.onShieldBreak();
  }

  private beginPhase2(): void {
    this.phase2Started = true;
    this.phase = 2;
    this.opts.onSay(SAY_P2);
    this.opts.onPhase(2);
    this.spawnT = 0;
  }

  private beginPhase3(): void {
    this.phase3Started = true;
    this.phase = 3;
    this.opts.onSay(SAY_P3);
    this.opts.onPhase(3);
    this.opts.onBpm(220);
    if (this.electricOn) {
      this.electricOn = false;
      this.opts.onElectric(false);
    }
    for (const l of this.lasers) l.pivot.visible = false;
    this.opts.megaRamp.surface.enabled = true;
  }

  /** Анимация гибели: пульт взрывается, корона улетает в камеру */
  private updateDeath(dt: number, env: EnemyEnv): void {
    this.deathT += dt;
    const k = Math.min(1, this.deathT / 2);
    this.group.rotation.x = k * 0.3;
    // Корона летит в камеру (локально -Z — к игроку, т.к. группа повёрнута на π)
    this.crownMesh.position.z = -k * 30;
    this.crownMesh.position.y = this.crownBaseY + k * 8;
    if (Math.floor(this.deathT * 6) !== Math.floor((this.deathT - dt) * 6)) {
      const p = this.group.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 12, 8 + Math.random() * 6, (Math.random() - 0.5) * 12));
      const colors = [0xff00ff, 0x00f0ff, 0xffd700, 0x39ff14];
      env.vfx.burst(p, colors[Math.floor(Math.random() * colors.length)], 60, 14, 1.2, 0.2, 10);
      env.audio.playExplosion(1.2);
    }
    if (this.deathT >= 2 && this.deathT - dt < 2) {
      this.opts.onSay(SAY_DEAD);
    }
  }

  update(dt: number, env: EnemyEnv): void {
    this.time += dt;
    for (const p of this.pylons) p.update(dt);
    this.hitSpark = Math.max(0, this.hitSpark - dt);
    for (const v of this.vinyl) v.rotation.y += dt * 4;
    this.lightBeam.rotation.y += dt * 1.5;
    if (this.dying) {
      this.updateDeath(dt, env);
      if (this.deathT >= 2 && this.deathT - dt < 2) {
        this.opts.onDefeat();
      }
      return;
    }
    if (this.tickDeath(dt)) return;
    if (!this.alive) return;

    const shieldLive = this.shieldUp ? 1 : 0;
    this.shieldMesh.visible = shieldLive > 0;
    if (this.shieldBreakT >= 0) {
      this.shieldBreakT += dt;
      const s = Math.max(0, 1 - this.shieldBreakT / 0.8);
      this.shieldMesh.visible = s > 0;
      this.shieldMesh.scale.setScalar(1 + (1 - s) * 0.4);
      (this.shieldMesh.material as THREE.MeshBasicMaterial).opacity = 0.18 * s;
      if (this.shieldBreakT > 0.8) this.shieldBreakT = -1;
    }
    this.coreMesh.visible = !this.shieldUp;

    // Пульт: руки-синтезаторы качаются
    const pumpL = Math.sin(this.time * 6) * 0.25;
    this.fistL.rotation.x = pumpL;
    this.fistR.rotation.x = -pumpL;

    if (!this.phase2Started && this.hp <= BOSS_HP * 0.65) this.beginPhase2();
    if (!this.phase3Started && this.hp <= BOSS_HP * 0.3) this.beginPhase3();

    // Болтовня
    this.sayT -= dt;
    if (this.sayT <= 0) {
      this.sayT = 9 + Math.random() * 3;
      this.opts.onSay(BANTER[Math.floor(Math.random() * BANTER.length)]);
    }

    // Фаза 1: лазеры и диско-сферы
    if (this.phase === 1) {
      for (const l of this.lasers) {
        l.pivot.visible = true;
        l.pivot.rotation.y += l.speed * dt * (this.shieldUp ? 1 : 1.6);
        this.checkLaser(l, env, dt);
      }
      this.shotT -= dt;
      if (this.shotT <= 0) {
        this.shotT = 2.2;
        const from = this.group.position.clone().add(new THREE.Vector3(0, 9, 0));
        const to = env.player.pos.clone().add(new THREE.Vector3(0, 1, 0));
        env.shots.discoOrb(from, to, 22, 12, () => env.hurtPlayer(12, 'ДИСКО-СФЕРА'));
        env.audio.playZap();
      }
    } else {
      for (const l of this.lasers) l.pivot.visible = false;
    }

    // Фаза 2: электропол — 10-секундный цикл: 1.5 с предупреждение, затем 6 с тока
    if (this.phase === 2) {
      this.electricT += dt;
      if (this.electricT >= ELECTRIC_PERIOD) this.electricT -= ELECTRIC_PERIOD;
      const t = this.electricT;
      // Предупреждение за 1.5 с до разряда: щелчок один раз за цикл
      if (t >= ELECTRIC_PERIOD - ELECTRIC_WARN && !this.electricWarned) {
        this.electricWarned = true;
        env.audio.playMenuClick();
      }
      if (t < ELECTRIC_PERIOD - ELECTRIC_WARN) this.electricWarned = false;
      const activeNow = t < ELECTRIC_ACTIVE;
      if (activeNow !== this.electricOn) {
        this.electricOn = activeNow;
        this.opts.onElectric(activeNow);
      }
      if (activeNow && env.player.surface?.kind === 'floor') {
        env.hurtPlayer(ELECTRIC_DPS * dt, 'ТОК ОТ ПОЛА');
      }
      this.spawnT += dt;
      if (this.spawnT >= 6) {
        this.spawnT = 0;
        this.spawnPlatformWave();
      }
    }

    // Фаза 3: мега-рампа выдвигается и отображается
    if (this.phase === 3 && this.opts.megaRamp.group.scale.y < 1) {
      this.opts.megaRamp.group.scale.y = Math.min(1, this.opts.megaRamp.group.scale.y + dt * 0.9);
    }
  }

  /** Лазер: удар при касании игрока, если он ниже 1.5 м над полом */
  private checkLaser(l: Laser, env: EnemyEnv, dt: number): void {
    if (!l.pivot.visible) return;
    const origin = this.group.position;
    const dir = new THREE.Vector3(Math.sin(l.pivot.rotation.y), 0, Math.cos(l.pivot.rotation.y));
    const p = env.player.pos;
    const rel = new THREE.Vector3(p.x - origin.x, 0, p.z - origin.z);
    const along = rel.dot(dir);
    if (along < 0 || along > 44) return;
    const perp = Math.abs(rel.x * dir.z - rel.z * dir.x);
    const beamY = origin.y + 1.0;
    if (perp < 1.1 && Math.abs(p.y - beamY) < 1.3) {
      env.hurtPlayer(25 * dt, 'ЛАЗЕР БОССА');
    }
  }

  /** Волна ящеров-рейверов и дронов на платформах */
  private spawnPlatformWave(): void {
    for (const pf of this.opts.platforms) {
      const c = new THREE.Vector3(pf.origin.x, pf.origin.y + 0.2, pf.origin.z);
      const k = Math.random() < 0.5 ? 'raver' : 'drone';
      this.opts.onSpawn(k, c);
    }
  }
}

/** Голова, корпус и руки босса: пульт, сабвуферы, винил, МС Гига-Ящер на плече */
function buildBoss(): Rig & { extra: Record<string, THREE.Object3D> } {
  const root = new THREE.Group();
  const chrome = createPS1Material({ color: 0xffffff, map: pixelTexture(chromeCanvas(), 1, 1) });
  const dark = lambert(0x16161f);
  const neonPink = createPS1Material({ color: 0xff00ff, emissive: 0xff00ff, emissiveIntensity: 1.2 });
  const cyan = createPS1Material({ color: 0x00f0ff, emissive: 0x00f0ff, emissiveIntensity: 1.2 });
  const gold = createPS1Material({ color: 0xffd700, emissive: 0xffaa00, emissiveIntensity: 0.9 });
  const spk = createPS1Material({ color: 0xffffff, map: pixelTexture(speakerCanvas(), 1, 1) });
  const vinylMat = createPS1Material({ color: 0xffffff, map: pixelTexture(vinylCanvas(), 1, 1) });
  const core = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 8), createPS1Material({ color: 0xff00ff, emissive: 0xff00ff, emissiveIntensity: 2 }));
  core.position.set(0, 6.5, -1.4);
  const rb = new THREE.Group();
  root.add(rb);
  const bossBody = new THREE.Group();
  rb.add(bossBody);

  // Торс-шкаф и голова
  mesh(bossBody, new THREE.BoxGeometry(5.4, 6.2, 3.4), chrome, 0, 5.2, 0);
  mesh(bossBody, new THREE.BoxGeometry(5.6, 0.35, 3.6), dark, 0, 8.4, 0);
  mesh(bossBody, new THREE.BoxGeometry(3.6, 2.6, 1.0), dark, 0, 5.4, -1.8);
  mesh(bossBody, new THREE.BoxGeometry(1.6, 0.8, 0.4), cyan, 0, 6.2, -2.3);
  bossBody.add(core);
  const head = new THREE.Group();
  head.position.set(0, 9.2, 0);
  bossBody.add(head);
  mesh(head, new THREE.BoxGeometry(2.4, 1.9, 2.0), chrome, 0, 0, 0);
  mesh(head, new THREE.BoxGeometry(2.0, 0.4, 0.1), cyan, 0, 0.1, -1.05);
  const crown = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.4, 6), gold);
  crown.position.set(0, 2.1, 0);
  head.add(crown);

  // Пульт DJ: консоль и винил
  mesh(bossBody, new THREE.BoxGeometry(9.5, 1.2, 3.2), dark, 0, 0.6, -6.5);
  const vinylL = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.1, 16), vinylMat);
  vinylL.rotation.x = Math.PI / 2;
  vinylL.position.set(-2.4, 1.6, -6.6);
  rb.add(vinylL);
  const vinylR = vinylL.clone();
  vinylR.position.x = 2.4;
  rb.add(vinylR);
  // Стена сабвуферов
  for (let i = 0; i < 3; i++) {
    mesh(rb, new THREE.BoxGeometry(2.6, 2.6, 0.5), spk, -4.4 + i * 4.4, 2.2, -9.4);
  }
  // Четыре руки-«фейдеры»: две на пульте, две поднятые
  const armPivots: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const up = new THREE.Group();
    up.position.set(3.2 * sx, 8.0, 0);
    bossBody.add(up);
    mesh(up, new THREE.BoxGeometry(0.9, 3.6, 0.9), chrome, 0, -1.8, 0);
    const fist = mesh(up, new THREE.BoxGeometry(1.5, 1.5, 1.5), spk, 0, -4.0, 0);
    armPivots.push(up);
    void fist;
  }
  const lowL = new THREE.Group();
  lowL.position.set(-3.0, 4.0, -1.0);
  bossBody.add(lowL);
  mesh(lowL, new THREE.BoxGeometry(0.8, 3.0, 0.8), chrome, 0, -1.4, -0.8);
  const lowR = new THREE.Group();
  lowR.position.set(3.0, 4.0, -1.0);
  bossBody.add(lowR);
  mesh(lowR, new THREE.BoxGeometry(0.8, 3.0, 0.8), chrome, 0, -1.4, -0.8);

  // Ножки
  const legL = new THREE.Group();
  legL.position.set(-1.3, 2.4, 0);
  bossBody.add(legL);
  mesh(legL, new THREE.BoxGeometry(1.2, 2.4, 1.2), dark, 0, -1.2, 0);
  const legR = new THREE.Group();
  legR.position.set(1.3, 2.4, 0);
  bossBody.add(legR);
  mesh(legR, new THREE.BoxGeometry(1.2, 2.4, 1.2), dark, 0, -1.2, 0);

  // МС ГИГА-ЯЩЕР на правом плече: зелёный ящер, цепь, микрофон
  const giga = new THREE.Group();
  giga.position.set(3.6, 7.8, 0.8);
  bossBody.add(giga);
  mesh(giga, new THREE.BoxGeometry(0.9, 1.4, 0.7), neonPink, 0, 0, 0);
  mesh(giga, new THREE.BoxGeometry(0.7, 0.7, 0.7), lambert(0x39ff14), 0, 1.0, 0);
  mesh(giga, new THREE.BoxGeometry(0.3, 0.3, 0.9), gold, 0.5, 0.5, 0.3);

  // Световой луч над боссом
  const beam = new THREE.Mesh(new THREE.ConeGeometry(4, 18, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xff00ff, transparent: true, opacity: 0.12, depthWrite: false }));
  beam.position.y = 9;
  rb.add(beam);

  return {
    root,
    body: bossBody,
    head,
    armL: lowL,
    armR: lowR,
    legL,
    legR,
    extra: {
      fistL: armPivots[0],
      fistR: armPivots[1],
      core,
      crown,
      vinylL,
      vinylR,
      beam,
    },
    glow: [neonPink, cyan],
  };
}

function mesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function chromeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    for (let y = 0; y < 64; y++) {
      const v = 120 + Math.round(90 * Math.abs(Math.sin(y / 9)));
      g.fillStyle = `rgb(${v},${v + 10},${v + 20})`;
      g.fillRect(0, y, 64, 1);
    }
  }
  return c;
}

function speakerCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#101018';
    g.fillRect(0, 0, 64, 64);
    g.strokeStyle = '#ff00ff';
    g.lineWidth = 4;
    for (let r = 8; r < 34; r += 8) {
      g.beginPath();
      g.arc(32, 32, r, 0, Math.PI * 2);
      g.stroke();
    }
  }
  return c;
}

function vinylCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#0a0a0a';
    g.fillRect(0, 0, 64, 64);
    g.strokeStyle = '#ff00ff';
    g.lineWidth = 2;
    for (let r = 4; r < 30; r += 4) {
      g.beginPath();
      g.arc(32, 32, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = '#00f0ff';
    g.fillRect(30, 30, 4, 4);
  }
  return c;
}
