import * as THREE from 'three';
import { createPS1Material, lambert } from '../shaders/PS1Material';
import { getSkinTexture, PALETTE } from '../customization/SkinGenerator';
import { CustomConfig, GrindStyle, SkinConfig, WeaponSlot } from '../types';

/** Длина сегментов ноги (бедро = голень), м */
const LEG = 0.5;
/** Высота «ступни» над полом — верх деки */
const ANKLE_Y = 0.31;

export interface SpinState {
  x: number;
  y: number;
  z: number;
}

/** Состояние, которое контроллер передаёт модели каждый кадр */
export interface ModelState {
  speed: number;
  grounded: boolean;
  airborne: boolean;
  grindStyle: GrindStyle | null;
  lean: number;
  pushing: boolean;
  dt: number;
  time: number;
}

/** Аналитическое IK двух сегментов в сагиттальной плоскости.
 *  footY/footZ — цель ступни относительно точки бедра (бедро в X=0). Колени сгибаются вперёд (к -Z). */
function solveLeg(footY: number, footZ: number): { thigh: number; shin: number } {
  const down = -footY;
  const fwd = -footZ;
  const d = THREE.MathUtils.clamp(Math.hypot(down, fwd), 0.05, 2 * LEG - 0.01);
  const base = Math.atan2(fwd, down);
  const a = Math.acos(THREE.MathUtils.clamp(d / (2 * LEG), -1, 1));
  return { thigh: base + a, shin: -2 * a };
}

function box(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

interface Butterfly {
  root: THREE.Group;
  safe: THREE.Group;
  bite: THREE.Group;
}

/** Нож-бабочка из 3 шарнирных частей: клинок (неподвижен), левая и правая рукоять (вращаются вокруг оси пина) */
function buildButterfly(parent: THREE.Object3D, handleMat: THREE.Material, bladeMat: THREE.Material): Butterfly {
  const root = new THREE.Group();
  parent.add(root);
  box(root, 0.03, 0.012, 0.25, 0, 0, -0.125, bladeMat); // Blade
  const safe = new THREE.Group();
  root.add(safe);
  box(safe, 0.13, 0.03, 0.05, 0.065, 0, 0, handleMat); // SafeHandle
  const bite = new THREE.Group();
  root.add(bite);
  box(bite, 0.13, 0.03, 0.05, 0.065, 0, 0, handleMat); // BiteHandle
  return { root, safe, bite };
}

/** Пушка «ЯЩЕРОРЕЗ-909»: ствол вдоль -Z, рукоять в начале координат, магазин — отдельная группа */
function buildGun(parent: THREE.Object3D, bodyMat: THREE.Material, darkMat: THREE.Material, neonMat: THREE.Material): { root: THREE.Group; mag: THREE.Group; muzzle: THREE.Object3D; tilt: THREE.Group } {
  const root = new THREE.Group();
  parent.add(root);
  const tilt = new THREE.Group();
  root.add(tilt);
  box(tilt, 0.08, 0.12, 0.3, 0, 0, -0.12, bodyMat);
  box(tilt, 0.075, 0.05, 0.26, 0, 0.085, -0.12, darkMat);
  box(tilt, 0.045, 0.045, 0.18, 0, 0.02, -0.36, darkMat);
  box(tilt, 0.02, 0.02, 0.02, 0, 0.1, -0.22, neonMat);
  box(tilt, 0.07, 0.14, 0.07, 0, -0.1, 0.0, darkMat);
  const mag = new THREE.Group();
  mag.position.set(0, -0.06, -0.06);
  tilt.add(mag);
  box(mag, 0.05, 0.17, 0.07, 0, -0.08, 0, neonMat);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -0.5);
  tilt.add(muzzle);
  return { root, mag, muzzle, tilt };
}

/**
 * PlayerModel: полный процедурный PS1-риг скейтера (куртка, кепка-очки, перчатки, скейт, пушка, нож).
 * Иерархия: root (позиция/курс) → lean (крен) → spin (флипы/вертушки) → body + boardPivot.
 * Ноги решаются IK, руки — целевыми позами по слотам 1/2/3.
 */
export class PlayerModel {
  readonly root = new THREE.Group();
  private readonly lean = new THREE.Group();
  private readonly spin = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly hips = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly shR = new THREE.Group();
  private readonly elR = new THREE.Group();
  private readonly handR = new THREE.Group();
  private readonly shL = new THREE.Group();
  private readonly elL = new THREE.Group();
  private readonly handL = new THREE.Group();
  private readonly hipR = new THREE.Group();
  private readonly kneeR = new THREE.Group();
  private readonly hipL = new THREE.Group();
  private readonly kneeL = new THREE.Group();
  private readonly boardPivot = new THREE.Group();
  private readonly wheels: THREE.Mesh[] = [];
  private readonly gunRoot: THREE.Group;
  private readonly gunTilt: THREE.Group;
  private readonly gunMag: THREE.Group;
  private readonly gunMuzzle: THREE.Object3D;
  private readonly gunBack = new THREE.Group();
  private readonly knifeHand = new THREE.Group();
  private readonly knifeBF: Butterfly;
  private readonly holsterKnife = new THREE.Group();
  private readonly holsterBF: Butterfly;

  private readonly playerMat: THREE.MeshLambertMaterial;
  private readonly boardTopMat: THREE.MeshLambertMaterial;
  private readonly gunMat: THREE.MeshLambertMaterial;
  private readonly knifeMat: THREE.MeshLambertMaterial;
  private readonly wheelMat: THREE.MeshLambertMaterial;
  private readonly neonMats: THREE.MeshLambertMaterial[] = [];

  private slot: WeaponSlot = 1;
  private slash = 0;
  private reloadT = -1;
  readonly reloadDur = 1.05;
  private recoilT = 0;
  private flexT = 0;
  private pushT = 0;
  private pushPhase = -1;
  private aimYaw = 0;
  private aimPitch = 0;
  private crouch = 0;
  private armR = { x: 0.1, z: 0.12, e: 0.2 };
  private armL = { x: 0.1, z: -0.12, e: 0.2 };
  private spinBody: SpinState = { x: 0, y: 0, z: 0 };
  private spinBoard: SpinState = { x: 0, y: 0, z: 0 };
  private wheelSpin = 0;

  constructor(cfg: CustomConfig) {
    const p = cfg.player;
    this.playerMat = createPS1Material({ color: 0xffffff, map: getSkinTexture(p) });
    this.boardTopMat = createPS1Material({ color: 0xffffff, map: getSkinTexture(cfg.board) });
    this.gunMat = createPS1Material({ color: 0xffffff, map: getSkinTexture(cfg.gun) });
    this.knifeMat = createPS1Material({ color: 0xffffff, map: getSkinTexture(cfg.knife) });
    const darkMat = lambert(0x1c1a26);
    const pantsMat = lambert(0x161622);
    const skinMat = lambert(0xd9a57a);
    const bladeMat = lambert(0xd8e0ea);
    const holsterMat = lambert(0x0c0c12);
    const deckSideMat = lambert(0x222230);
    this.wheelMat = createPS1Material({ color: PALETTE[cfg.board.secondary].hex, emissive: PALETTE[cfg.board.secondary].hex, emissiveIntensity: 0.7 });
    const neonMat = createPS1Material({ color: 0x00f0ff, emissive: 0x00f0ff, emissiveIntensity: 1.2 });
    const glassMat = createPS1Material({ color: 0x39ff14, emissive: 0x39ff14, emissiveIntensity: 1.4 });
    this.neonMats.push(neonMat, glassMat, this.wheelMat);

    // --- Иерархия ---
    this.root.add(this.lean);
    this.lean.add(this.spin);
    this.spin.position.y = 0.8;
    this.spin.add(this.body);
    this.body.position.y = -0.8;
    this.body.add(this.hips);
    this.hips.position.set(0, 1.0, 0);
    this.hips.add(this.torso);
    this.torso.position.set(0, 0.32, 0);
    this.torso.add(this.head);
    this.head.position.set(0, 0.5, 0);

    // Торс и куртка (текстура игрока)
    box(this.torso, 0.46, 0.6, 0.26, 0, 0, 0, this.playerMat);
    box(this.torso, 0.48, 0.1, 0.28, 0, -0.26, 0, pantsMat);
    // Голова, кепка-очки, рот-шея
    box(this.head, 0.26, 0.28, 0.26, 0, 0.02, 0, skinMat);
    box(this.head, 0.3, 0.09, 0.3, 0, 0.17, 0, this.playerMat);
    box(this.head, 0.32, 0.03, 0.12, 0, 0.13, -0.2, this.playerMat);
    box(this.head, 0.24, 0.06, 0.03, 0, 0.03, -0.14, glassMat);
    box(this.head, 0.1, 0.05, 0.02, 0.0, -0.08, -0.14, lambert(0x6a2a2a));

    // Руки: плечо → локоть → кисть (перчатка из текстуры игрока)
    for (const [sh, el, hd, sx] of [
      [this.shR, this.elR, this.handR, 1],
      [this.shL, this.elL, this.handL, -1],
    ] as const) {
      sh.position.set(0.3 * sx, 0.22, 0);
      this.torso.add(sh);
      box(sh, 0.15, 0.42, 0.15, 0, -0.2, 0, this.playerMat);
      el.position.set(0, -0.42, 0);
      sh.add(el);
      box(el, 0.14, 0.4, 0.14, 0, -0.2, 0, this.playerMat);
      hd.position.set(0, -0.4, 0);
      el.add(hd);
      box(hd, 0.16, 0.16, 0.17, 0, -0.1, 0, this.playerMat);
      box(hd, 0.17, 0.05, 0.18, 0, -0.02, 0, neonMat);
    }

    // Ноги: бедро → колено → голень → кроссовка (IK)
    for (const [hip, knee, sx] of [
      [this.hipR, this.kneeR, 1],
      [this.hipL, this.kneeL, -1],
    ] as const) {
      hip.position.set(0.13 * sx, 0, 0);
      this.hips.add(hip);
      box(hip, 0.2, 0.5, 0.22, 0, -0.25, 0, pantsMat);
      knee.position.set(0, -0.5, 0);
      hip.add(knee);
      box(knee, 0.18, 0.5, 0.2, 0, -0.25, 0, pantsMat);
      box(knee, 0.2, 0.1, 0.34, 0, -0.56, -0.05, lambert(0xe8e8f0));
    }

    // Скейт (в собственном pivot для трюков)
    this.spin.add(this.boardPivot);
    this.boardPivot.position.set(0, 0.12 - 0.8, 0);
    const deckGeo = new THREE.BoxGeometry(0.26, 0.035, 0.86);
    // Верхняя грань деки — текстура, остальные грани — однотонные
    const deckMats = [deckSideMat, deckSideMat, this.boardTopMat, deckSideMat, deckSideMat, deckSideMat];
    const deck = new THREE.Mesh(deckGeo, deckMats);
    deck.position.set(0, 0.07, 0);
    this.boardPivot.add(deck);
    box(this.boardPivot, 0.26, 0.02, 0.1, 0, 0.1, 0.42, deckSideMat);
    box(this.boardPivot, 0.26, 0.02, 0.1, 0, 0.1, -0.42, deckSideMat);
    const wheelGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.05, 10);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const wx of [-0.13, 0.13]) {
      for (const wz of [-0.3, 0.3]) {
        const w = new THREE.Mesh(wheelGeo, this.wheelMat);
        w.position.set(wx, -0.05, wz);
        this.boardPivot.add(w);
        this.wheels.push(w);
      }
    }
    for (const wz of [-0.3, 0.3]) {
      box(this.boardPivot, 0.3, 0.03, 0.04, 0, -0.01, wz, deckSideMat);
    }

    // Пушка в руке (слот 1)
    const gun = buildGun(this.handR, this.gunMat, darkMat, neonMat);
    this.gunRoot = gun.root;
    this.gunRoot.rotation.x = -Math.PI / 2;
    this.gunRoot.position.set(0, -0.02, 0);
    this.gunTilt = gun.tilt;
    this.gunMag = gun.mag;
    this.gunMuzzle = gun.muzzle;

    // Пушка за спиной по диагонали (BackMount, слоты 2 и 3)
    this.torso.add(this.gunBack);
    this.gunBack.position.set(0.14, 0.12, 0.2);
    this.gunBack.rotation.set(0.35, 0, -0.8);
    const backGun = buildGun(this.gunBack, this.gunMat, darkMat, neonMat);
    backGun.root.rotation.x = Math.PI / 2;

    // Бабочка в руке (слот 2)
    this.handR.add(this.knifeHand);
    this.knifeHand.position.set(0, -0.06, 0);
    this.knifeHand.rotation.x = -Math.PI / 2;
    this.knifeBF = buildButterfly(this.knifeHand, this.knifeMat, bladeMat);

    // Бабочка в чехле на бедре (HipHolster, слоты 1 и 3)
    this.hips.add(this.holsterKnife);
    this.holsterKnife.position.set(0.22, 0.08, 0.03);
    this.holsterKnife.rotation.set(Math.PI / 2, 0, -0.15);
    this.holsterBF = buildButterfly(this.holsterKnife, this.knifeMat, bladeMat);
    box(this.holsterKnife, 0.11, 0.2, 0.09, 0, -0.1, 0, holsterMat);

    this.setSlot(1);
    this.setSpinNone();
  }

  /** Назначает слот экипировки: перераспределяет пушку и нож по телу */
  setSlot(slot: WeaponSlot): void {
    this.slot = slot;
    this.gunRoot.visible = slot === 1;
    this.knifeHand.visible = slot === 2;
    this.gunBack.visible = slot !== 1;
    this.holsterKnife.visible = slot !== 2;
    if (slot !== 1) this.reloadT = -1;
  }

  getSlot(): WeaponSlot {
    return this.slot;
  }

  /** Перекраска по данным кастомизации (без пересоздания геометрии) */
  applySkins(cfg: CustomConfig): void {
    const set = (mat: THREE.MeshLambertMaterial, c: SkinConfig): void => {
      mat.map = getSkinTexture(c);
      mat.needsUpdate = true;
    };
    set(this.playerMat, cfg.player);
    set(this.boardTopMat, cfg.board);
    set(this.gunMat, cfg.gun);
    set(this.knifeMat, cfg.knife);
    const wc = PALETTE[cfg.board.secondary].hex;
    this.wheelMat.color.setHex(wc);
    this.wheelMat.emissive.setHex(wc);
    this.knifeMat.needsUpdate = true;
  }

  /** Применение спина флипа/вертушки: body — всё тело, board — только деки */
  setSpin(body: SpinState, board: SpinState): void {
    this.spinBody = body;
    this.spinBoard = board;
  }

  private setSpinNone(): void {
    this.spinBody = { x: 0, y: 0, z: 0 };
    this.spinBoard = { x: 0, y: 0, z: 0 };
  }

  /** Направление прицеливания в локальных углах скейтера (рад): авто-цель ЛКМ */
  aimAt(yawLocal: number, pitchLocal: number): void {
    this.aimYaw = THREE.MathUtils.clamp(yawLocal, -1.2, 1.2);
    this.aimPitch = THREE.MathUtils.clamp(pitchLocal, -0.6, 0.6);
  }

  playSlash(): void {
    this.slash = 0.26;
  }

  playReload(): void {
    this.reloadT = 0;
  }

  isReloading(): boolean {
    return this.reloadT >= 0;
  }

  recoil(): void {
    this.recoilT = 1;
  }

  playFlex(): void {
    this.flexT = 0.6;
  }

  /** Номер цикла пуша (для анимации толчка правой ногой) */
  playPush(): void {
    if (this.pushPhase < 0) this.pushPhase = 0;
  }

  /** Мировая точка дула */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.gunMuzzle.getWorldPosition(out);
  }

  /** Мировая точка рукояти пушки */
  gunWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.gunRoot.getWorldPosition(out);
  }

  /** Мировая точка руки с ножом (центр сцены ножа) */
  knifeWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.knifeHand.getWorldPosition(out);
  }

  isKnifeSpinning(): boolean {
    return this.slot === 2 && this.slash <= 0;
  }

  update(dt: number, t: number, st: ModelState): void {
    // --- Таймеры анимаций ---
    if (this.slash > 0) this.slash = Math.max(0, this.slash - dt);
    if (this.reloadT >= 0) {
      this.reloadT += dt;
      if (this.reloadT >= this.reloadDur) this.reloadT = -1;
    }
    this.recoilT = Math.max(0, this.recoilT - dt * 9);
    this.flexT = Math.max(0, this.flexT - dt);
    if (st.grounded && st.pushing && st.speed < 23 && this.pushPhase < 0) {
      this.pushT += dt;
      if (this.pushT >= 1.6) {
        this.pushT = 0;
        this.pushPhase = 0;
      }
    }
    if (this.pushPhase >= 0) {
      this.pushPhase += dt / 0.6;
      if (this.pushPhase >= 1) this.pushPhase = -1;
    }

    // --- Присед и корпус ---
    let crouchT = 0.12 + Math.min(0.1, st.speed / 240);
    if (st.grindStyle) crouchT = st.grindStyle === '50-50' ? 0.9 : 0.45;
    else if (st.airborne) crouchT = 0.25;
    this.crouch += (crouchT - this.crouch) * Math.min(1, dt * 8);
    const hipY = 1.0 - this.crouch * 0.16;
    this.hips.position.y = hipY;
    this.torso.rotation.x = 0.12 + this.crouch * 0.25;
    this.lean.rotation.z += (st.lean - this.lean.rotation.z) * Math.min(1, dt * 10);

    // --- Ноги (IK): цели ступней на деке ---
    let frZ = 0.2;
    let flZ = -0.2;
    let frY = ANKLE_Y;
    let flY = ANKLE_Y;
    if (st.airborne) {
      frY = 0.5;
      flY = 0.5;
      frZ = 0.15;
      flZ = -0.15;
    }
    if (st.grindStyle === '50-50') {
      frZ = 0.15;
      flZ = -0.15;
    }
    if (st.grindStyle === 'slavslide') {
      frZ = 0.36;
      flZ = -0.36;
    }
    if (this.pushPhase >= 0 && st.grounded) {
      const s = Math.sin(this.pushPhase * Math.PI);
      frZ = 0.2 + s * 0.6;
      frY = ANKLE_Y + s * 0.1;
    }
    const legR = solveLeg(frY - hipY, frZ);
    const legL = solveLeg(flY - hipY, flZ);
    this.hipR.rotation.x = legR.thigh;
    this.kneeR.rotation.x = legR.shin;
    this.hipL.rotation.x = legL.thigh;
    this.kneeL.rotation.x = legL.shin;

    // --- Руки по слотам ---
    let R = { x: 0.1, z: 0.12, e: 0.2 };
    let L = { x: 0.1, z: -0.12, e: 0.2 };
    if (this.slot === 1) {
      R = { x: 1.35 - this.aimPitch, z: 0.0, e: 0.05 };
      L = { x: 1.15, z: 0.45, e: 1.0 };
      if (this.reloadT >= 0) {
        const p = this.reloadT / this.reloadDur;
        if (p > 0.2 && p < 0.7) L = { x: 1.3, z: 0.25, e: 1.5 };
      }
      if (this.recoilT > 0) R.x -= this.recoilT * 0.18;
    } else if (this.slot === 2) {
      R = { x: 0.9, z: -0.25, e: 1.4 };
      L = { x: 0.8, z: -0.2, e: 0.8 };
      if (this.slash > 0) {
        const p = 1 - this.slash / 0.26;
        const ease = 1 - Math.pow(1 - p, 3);
        R = { x: THREE.MathUtils.lerp(1.9, -0.9, ease), z: -0.4, e: 0.2 };
      }
    } else {
      const bob = Math.sin(t * 6.5) * 0.25;
      R = { x: 0.1 + bob, z: 1.1, e: 0.25 };
      L = { x: 0.1 - bob, z: -1.1, e: 0.25 };
      if (this.flexT > 0) {
        R = { x: 0.3, z: 2.8, e: 0.2 };
        L = { x: 0.3, z: -2.8, e: 0.2 };
      }
    }
    if (st.grindStyle && this.slot !== 1) {
      if (st.grindStyle === 'slavslide') {
        R = { x: -0.4, z: 2.0, e: 0.6 };
        L = { x: 0.1, z: -1.0, e: 0.4 };
      } else {
        R = { x: 0.1, z: 1.1, e: 0.4 };
        L = { x: 0.1, z: -1.1, e: 0.4 };
      }
    }
    if (st.airborne && !st.grindStyle && this.slot !== 1) {
      R.z = Math.max(R.z, 0.8);
      L.z = Math.min(L.z, -0.8);
    }
    const k = Math.min(1, dt * 14);
    this.armR.x += (R.x - this.armR.x) * k;
    this.armR.z += (R.z - this.armR.z) * k;
    this.armR.e += (R.e - this.armR.e) * k;
    this.armL.x += (L.x - this.armL.x) * k;
    this.armL.z += (L.z - this.armL.z) * k;
    this.armL.e += (L.e - this.armL.e) * k;
    this.shR.rotation.set(this.armR.x, 0, this.armR.z);
    this.elR.rotation.set(this.armR.e, 0, 0);
    this.shL.rotation.set(this.armL.x, 0, this.armL.z);
    this.elL.rotation.set(this.armL.e, 0, 0);

    // Прицел: торс и правое плечо поворачиваются к цели
    if (this.slot === 1) {
      this.torso.rotation.y += (this.aimYaw * 0.55 - this.torso.rotation.y) * Math.min(1, dt * 12);
      this.shR.rotation.y = this.aimYaw * 0.4;
    } else {
      this.torso.rotation.y += (0 - this.torso.rotation.y) * Math.min(1, dt * 10);
      this.shR.rotation.y = 0;
    }
    this.head.rotation.y = -this.torso.rotation.y * 0.5;

    // --- Пушка: отдача и перезарядка ---
    this.gunTilt.position.z = this.recoilT * 0.05;
    if (this.reloadT >= 0) {
      const p = this.reloadT / this.reloadDur;
      let tilt = 0;
      if (p < 0.4) tilt = Math.sin((p / 0.4) * (Math.PI / 2)) * 0.8;
      else if (p < 0.8) tilt = 0.8 * (1 - (p - 0.4) / 0.4);
      this.gunTilt.rotation.z = tilt;
      let my = 0;
      if (p > 0.2 && p < 0.4) my = -0.35 * ((p - 0.2) / 0.2);
      else if (p >= 0.4 && p < 0.7) my = -0.35;
      else if (p >= 0.7) my = -0.35 + 0.35 * ((p - 0.7) / 0.3);
      this.gunMag.position.y = my;
    } else {
      this.gunTilt.rotation.z = 0;
      this.gunMag.position.y = 0;
    }

    // --- Нож-бабочка: непрерывное кручение «восьмёркой» или боевой хват ---
    if (this.isKnifeSpinning()) {
      const a = t * 9;
      this.knifeBF.safe.rotation.z = a;
      this.knifeBF.bite.rotation.z = a + Math.PI;
      this.knifeBF.root.rotation.set(Math.sin(t * 5) * 0.8, 0, Math.sin(t * 2.5) * 0.9);
    } else {
      this.knifeBF.safe.rotation.z = 0;
      this.knifeBF.bite.rotation.z = 0;
      this.knifeBF.root.rotation.set(0, 0, 0);
    }
    this.holsterBF.safe.rotation.z = 0;
    this.holsterBF.bite.rotation.z = 0;

    // --- Грайнд: поза доски ---
    let boardYaw = 0;
    let boardPitch = 0;
    if (st.grindStyle === 'boardslide') boardYaw = Math.PI / 2;
    if (st.grindStyle === 'nosegrind') boardPitch = -0.22;

    // --- Трюковые вращения ---
    this.spin.rotation.set(this.spinBody.x, this.spinBody.y, this.spinBody.z);
    this.boardPivot.rotation.set(
      this.spinBoard.x + boardPitch,
      this.spinBoard.y + boardYaw,
      this.spinBoard.z,
    );

    // --- Колёса ---
    this.wheelSpin += (st.speed * dt) / 0.07;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
  }
}

