import * as THREE from 'three';
import { createPS1Material, lambert, pixelTexture, unlit } from '../shaders/PS1Material';

/** Скелет врага: корень группы + суставы для процедурной анимации */
export interface Rig {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  /** Дополнительные подвижные части (крылья, хвост, пульсирующий диффузор, кулаки) */
  extra: Record<string, THREE.Object3D>;
  /** Материалы, которые мигают в бит/при атаке */
  glow: THREE.MeshLambertMaterial[];
}

/** Коробка с центром и размером относительно родителя */
function bx(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function joint(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

/** 64×64 процедурная пиксельная текстура по функции рисования */
function tex(draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) draw(g);
  return pixelTexture(c, 1, 1);
}

/** Чешуя ящера: тёмный фон и светлые ромбы-чешуйки */
const scaleTex = (base: string, light: string): THREE.CanvasTexture =>
  tex((g) => {
    g.fillStyle = base;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = light;
    for (let y = 0; y < 64; y += 4) {
      for (let x = (y / 4) % 2 === 0 ? 0 : 4; x < 64; x += 8) {
        g.fillRect(x, y, 3, 3);
      }
    }
  });

const stripeTex = (a: string, b: string): THREE.CanvasTexture =>
  tex((g) => {
    for (let x = 0; x < 64; x += 16) {
      g.fillStyle = a;
      g.fillRect(x, 0, 8, 64);
      g.fillStyle = b;
      g.fillRect(x + 8, 0, 8, 64);
    }
  });

const speakerTex = (): THREE.CanvasTexture =>
  tex((g) => {
    g.fillStyle = '#101018';
    g.fillRect(0, 0, 64, 64);
    g.strokeStyle = '#3a3a52';
    g.lineWidth = 3;
    for (let r = 6; r < 32; r += 7) {
      g.beginPath();
      g.arc(32, 32, r, 0, Math.PI * 2);
      g.stroke();
    }
  });

const chromeTex = (): THREE.CanvasTexture =>
  tex((g) => {
    for (let y = 0; y < 64; y++) {
      const v = 120 + Math.round(90 * Math.abs(Math.sin(y / 9)));
      g.fillStyle = `rgb(${v},${v + 10},${v + 20})`;
      g.fillRect(0, y, 64, 1);
    }
  });

/** ЯЩЕР-РЕЙВЕР: зелёная чешуя, олимпийка, очки, хвост, светящиеся палочки */
export function buildRaver(): Rig {
  const root = new THREE.Group();
  const body = joint(root, 0, 0, 0);
  const headJ = joint(body, 0, 1.45, 0);
  const scale = createPS1Material({ color: 0xffffff, map: scaleTex('#1f6b2a', '#7dff5a') });
  const jacket = createPS1Material({ color: 0xffffff, map: stripeTex('#141414', '#e8e8e8') });
  const pants = lambert(0x1b1b28);
  const glowPink = createPS1Material({ color: 0xff007f, emissive: 0xff007f, emissiveIntensity: 1.2 });
  const glowGreen = createPS1Material({ color: 0x39ff14, emissive: 0x39ff14, emissiveIntensity: 1.2 });
  const glasses = createPS1Material({ color: 0x00f0ff, emissive: 0x00f0ff, emissiveIntensity: 1.5 });
  const glow = [glowPink, glowGreen, glasses];

  bx(body, 0.5, 0.62, 0.3, 0, 0.9, 0, jacket);
  bx(body, 0.52, 0.12, 0.32, 0, 0.6, 0, pants);
  // Голова: вытянутая морда крокодила
  bx(headJ, 0.34, 0.3, 0.34, 0, 0.1, 0, scale);
  bx(headJ, 0.22, 0.16, 0.42, 0, 0.02, -0.34, scale);
  bx(headJ, 0.3, 0.09, 0.2, 0, 0.2, 0.02, scale);
  bx(headJ, 0.34, 0.09, 0.07, 0, 0.12, -0.12, glasses);
  bx(headJ, 0.24, 0.02, 0.12, 0, 0.08, -0.46, lambert(0xf0f0f0));

  // Руки с неоновыми палочками
  const armL = joint(body, -0.34, 1.12, 0);
  const armR = joint(body, 0.34, 1.12, 0);
  bx(armL, 0.14, 0.52, 0.14, 0, -0.26, 0, jacket);
  bx(armR, 0.14, 0.52, 0.14, 0, -0.26, 0, jacket);
  bx(armL, 0.12, 0.12, 0.12, 0, -0.56, 0, scale);
  bx(armR, 0.12, 0.12, 0.12, 0, -0.56, 0, scale);
  bx(armL, 0.05, 0.5, 0.05, 0.02, -0.7, -0.06, glowPink);
  bx(armR, 0.05, 0.5, 0.05, -0.02, -0.7, 0.06, glowGreen);

  const legL = joint(body, -0.14, 0.55, 0);
  const legR = joint(body, 0.14, 0.55, 0);
  bx(legL, 0.18, 0.55, 0.18, 0, -0.27, 0, pants);
  bx(legR, 0.18, 0.55, 0.18, 0, -0.27, 0, pants);
  bx(legL, 0.2, 0.1, 0.32, 0, -0.6, -0.05, lambert(0xe8e8f0));
  bx(legR, 0.2, 0.1, 0.32, 0, -0.6, -0.05, lambert(0xe8e8f0));

  // Хвост из трёх сегментов
  const tail = joint(body, 0, 0.7, 0.18);
  bx(tail, 0.2, 0.18, 0.4, 0, 0, 0.2, scale);
  const tail2 = joint(tail, 0, 0, 0.4);
  bx(tail2, 0.14, 0.13, 0.36, 0, 0, 0.18, scale);
  const tail3 = joint(tail2, 0, 0, 0.36);
  bx(tail3, 0.08, 0.08, 0.3, 0, 0, 0.14, scale);

  return { root, body, head: headJ, armL, armR, legL, legR, extra: { tail, tail2 }, glow };
}

/** КИБЕР-ЯЩЕР СНАЙПЕР: плащ, кибер-визор, длинная винтовка */
export function buildSniper(): Rig {
  const root = new THREE.Group();
  const body = joint(root, 0, 0, 0);
  const headJ = joint(body, 0, 1.6, 0);
  const scale = createPS1Material({ color: 0xffffff, map: scaleTex('#3a1a6e', '#39ff14') });
  const cloak = createPS1Material({ color: 0x2a0f4a, emissive: 0x330066, emissiveIntensity: 0.4 });
  const visor = createPS1Material({ color: 0x39ff14, emissive: 0x39ff14, emissiveIntensity: 1.6 });
  const metal = lambert(0x3a3a4a);
  const glow = [visor];

  // Длинный плащ — четырёхгранная призма
  const capeGeo = new THREE.CylinderGeometry(0.2, 0.42, 1.5, 4);
  const cape = new THREE.Mesh(capeGeo, cloak);
  cape.position.set(0, 0.75, 0);
  cape.rotation.y = Math.PI / 4;
  body.add(cape);
  bx(body, 0.4, 0.5, 0.26, 0, 1.15, 0, cloak);
  bx(headJ, 0.3, 0.3, 0.3, 0, 0.1, 0, scale);
  bx(headJ, 0.2, 0.14, 0.34, 0, 0.0, -0.26, scale);
  bx(headJ, 0.34, 0.1, 0.1, 0, 0.1, -0.15, visor);
  bx(headJ, 0.22, 0.02, 0.3, 0, 0.2, 0, metal);

  const armL = joint(body, -0.28, 1.36, 0);
  const armR = joint(body, 0.28, 1.36, 0);
  bx(armL, 0.13, 0.5, 0.13, 0, -0.25, 0, cloak);
  bx(armR, 0.13, 0.5, 0.13, 0, -0.25, 0, cloak);
  bx(armL, 0.12, 0.12, 0.12, 0, -0.52, 0, scale);
  bx(armR, 0.12, 0.12, 0.12, 0, -0.52, 0, scale);
  // Винтовка
  bx(armR, 0.07, 0.1, 1.2, 0.02, -0.52, -0.6, metal);
  bx(armR, 0.07, 0.12, 0.3, 0.02, -0.66, -0.25, metal);
  bx(armR, 0.04, 0.04, 0.22, 0.02, -0.5, -1.3, metal);
  bx(armL, 0.07, 0.07, 0.8, -0.02, -0.5, -0.4, metal);

  const legL = joint(body, -0.12, 0.6, 0);
  const legR = joint(body, 0.12, 0.6, 0);
  bx(legL, 0.16, 0.6, 0.16, 0, -0.3, 0, cloak);
  bx(legR, 0.16, 0.6, 0.16, 0, -0.3, 0, cloak);
  bx(legL, 0.18, 0.1, 0.3, 0, -0.64, -0.05, metal);
  bx(legR, 0.18, 0.1, 0.3, 0, -0.64, -0.05, metal);

  return { root, body, head: headJ, armL, armR, legL, legR, extra: {}, glow };
}

/** РОБОТ-ВЫШИБАЛА: хромированный шкаф, красный глаз, галстук-бабочка, кулаки-сабвуферы */
export function buildBouncer(): Rig {
  const root = new THREE.Group();
  const body = joint(root, 0, 0, 0);
  const headJ = joint(body, 0, 2.55, 0);
  const chrome = createPS1Material({ color: 0xffffff, map: chromeTex() });
  const dark = lambert(0x18181f);
  const eye = createPS1Material({ color: 0xff0033, emissive: 0xff0033, emissiveIntensity: 1.6 });
  const bow = createPS1Material({ color: 0xff0033, emissive: 0x880011, emissiveIntensity: 0.6 });
  const spk = createPS1Material({ color: 0xffffff, map: speakerTex() });
  const glow = [eye];

  bx(body, 1.2, 1.5, 0.9, 0, 1.7, 0, chrome);
  bx(body, 1.25, 0.12, 0.95, 0, 2.5, 0, dark);
  bx(body, 0.9, 0.9, 0.04, 0, 1.8, -0.47, dark);
  bx(headJ, 0.9, 0.5, 0.8, 0, 0.1, 0, chrome);
  bx(headJ, 0.62, 0.1, 0.04, 0, 0.05, -0.42, eye);
  bx(headJ, 0.2, 0.14, 0.04, 0, -0.1, -0.42, bow);
  bx(headJ, 0.38, 0.08, 0.04, 0.2, -0.12, -0.42, bow);
  bx(headJ, 0.38, 0.08, 0.04, -0.2, -0.12, -0.42, bow);
  bx(headJ, 0.2, 0.2, 0.03, 0, 0.35, -0.42, bow);

  // Огромные кулаки-сабвуферы
  const armL = joint(body, -0.92, 2.1, 0);
  const armR = joint(body, 0.92, 2.1, 0);
  bx(armL, 0.36, 0.9, 0.36, 0, -0.45, 0, chrome);
  bx(armR, 0.36, 0.9, 0.36, 0, -0.45, 0, chrome);
  const fistL = bx(armL, 0.8, 0.8, 0.8, 0, -1.2, 0, spk);
  const fistR = bx(armR, 0.8, 0.8, 0.8, 0, -1.2, 0, spk);

  const legL = joint(body, -0.34, 0.95, 0);
  const legR = joint(body, 0.34, 0.95, 0);
  bx(legL, 0.4, 0.95, 0.5, 0, -0.47, 0, dark);
  bx(legR, 0.4, 0.95, 0.5, 0, -0.47, 0, dark);
  bx(legL, 0.5, 0.18, 0.62, 0, -0.98, -0.05, dark);
  bx(legR, 0.5, 0.18, 0.62, 0, -0.98, -0.05, dark);

  return { root, body, head: headJ, armL, armR, legL, legR, extra: { fistL, fistR }, glow };
}

/** БАС-ДРОН: круглый динамик с крыльями и пульсирующим диффузором */
export function buildDrone(): Rig {
  const root = new THREE.Group();
  const body = joint(root, 0, 0, 0);
  const headJ = joint(body, 0, 0, 0);
  const shell = lambert(0x1c1c28);
  const cone = createPS1Material({ color: 0xff6600, emissive: 0xff6600, emissiveIntensity: 1.2 });
  const spk = createPS1Material({ color: 0xffffff, map: speakerTex() });
  const wingMat = lambert(0x9aa6b8);
  const glow = [cone];

  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.42, 8), shell);
  can.rotation.x = Math.PI / 2;
  headJ.add(can);
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.5, 8), spk);
  face.position.z = 0.22;
  headJ.add(face);
  const diff = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.2, 6), cone);
  diff.rotation.x = Math.PI / 2;
  diff.position.z = 0.25;
  headJ.add(diff);
  const wingL = joint(body, -0.5, 0.1, 0);
  const wingR = joint(body, 0.5, 0.1, 0);
  bx(wingL, 0.9, 0.04, 0.3, -0.45, 0, 0, wingMat);
  bx(wingR, 0.9, 0.04, 0.3, 0.45, 0, 0, wingMat);
  const armL = joint(body, 0, 0, 0);
  const armR = joint(body, 0, 0, 0);
  const legL = joint(body, 0, 0, 0);
  const legR = joint(body, 0, 0, 0);
  return { root, body, head: headJ, armL, armR, legL, legR, extra: { wingL, wingR, diff }, glow };
}

/** Снайперский луч (зелёный, ярче при наведении — белый перед выстрелом) */
export function buildLaser(): { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial } {
  const mat = unlit(0x39ff14, 0.8, true);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 1), mat);
  return { mesh, mat };
}
