import * as THREE from 'three';
import { pixelTexture } from '../shaders/PS1Material';
import { SkinConfig } from '../types';

/** Палитра из 12 цветов (раздел 7 спецификации) */
export const PALETTE: { name: string; hex: number }[] = [
  { name: 'Кислотно-зелёный', hex: 0x39ff14 },
  { name: 'Кибер-розовый', hex: 0xff007f },
  { name: 'Неон-циан', hex: 0x00f0ff },
  { name: 'Ультра-фиолет', hex: 0x8a00ff },
  { name: 'Кровавый красный', hex: 0xff1133 },
  { name: 'Золотой флекс', hex: 0xffd700 },
  { name: 'Угольно-чёрный', hex: 0x181820 },
  { name: 'Белый строб', hex: 0xf4f4ff },
  { name: 'Оранжевый рейв', hex: 0xff6600 },
  { name: 'Кобальт', hex: 0x0055ff },
  { name: 'Токсик-жёлтый', hex: 0xe6ff00 },
  { name: 'Хром', hex: 0xa8b8c8 },
];

/** 7 процедурных пиксельных узоров */
export const PATTERN_NAMES = [
  'Чистый цвет',
  'Три полоски',
  'Кислотный тигр',
  'Шахматка SKA',
  'Пламя рейва',
  'Кибер-сетка',
  'Брызги неона',
];

const N = 64;

function rgbOf(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scale(a: [number, number, number], k: number): [number, number, number] {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/** Детерминированный генератор случайных чисел (mulberry32) */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Рисует один из 7 узоров 64x64 в canvas */
export function drawSkinPattern(canvas: HTMLCanvasElement, primary: number, secondary: number, pattern: number): void {
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(N, N);
  const d = img.data;
  const P = rgbOf(primary);
  const S = rgbOf(secondary);
  const DARK = scale(P, 0.22);
  const rand = rng(1000 + pattern * 97 + primary * 13 + secondary * 7);

  // Заранее сгенерированные кляксы/росчерки для узора 7
  const blobs: { x: number; y: number; r: number }[] = [];
  const streaks: { k: number; off: number }[] = [];
  if (pattern === 6) {
    for (let i = 0; i < 46; i++) blobs.push({ x: rand() * N, y: rand() * N, r: 1.5 + rand() * 4.5 });
    for (let i = 0; i < 6; i++) streaks.push({ k: rand() < 0.5 ? 1 : -1, off: rand() * N });
  }

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c: [number, number, number] = P;
      switch (pattern) {
        case 0: {
          // ЧИСТЫЙ ЦВЕТ: градиент основного цвета + кайма вторичного
          const shade = 0.78 + 0.32 * (1 - y / (N - 1));
          c = scale(P, shade);
          const edge = x < 2 || x > N - 3 || y < 2 || y > N - 3;
          if (edge) c = S;
          break;
        }
        case 1: {
          // ТРИ ПОЛОСКИ (SLAV RAVE)
          const stripe = (x >= 14 && x <= 18) || (x >= 28 && x <= 33) || (x >= 44 && x <= 48);
          c = stripe ? S : scale(P, 0.9 + 0.12 * (1 - y / N));
          break;
        }
        case 2: {
          // КИСЛОТНЫЙ ТИГР: рваные диагональные полосы
          const dd = (((x + y * 0.6 + 4 * Math.sin(y * 0.5)) % 18) + 18) % 18;
          if (dd < 6) c = S;
          else if (dd < 7.2) c = mix(P, S, 0.5);
          else c = scale(P, 0.85);
          break;
        }
        case 3: {
          // ШАХМАТКА SKA: клетка 8x8
          const on = ((x >> 3) + (y >> 3)) & 1;
          c = on ? S : P;
          break;
        }
        case 4: {
          // ПЛАМЯ РЕЙВА: языки огня снизу вверх
          const h = 22 + 13 * Math.sin(x * 0.35) + 9 * Math.sin(x * 1.3 + 1.7) + 4 * Math.sin(x * 2.9);
          const fromBottom = N - 1 - y;
          if (fromBottom < h) {
            c = fromBottom < h * 0.45 ? S : mix(P, S, 0.5);
          } else {
            c = DARK;
          }
          break;
        }
        case 5: {
          // КИБЕР-СЕТКА: тёмная основа + светящаяся wireframe-решётка
          const line = x % 8 === 0 || y % 8 === 0;
          c = line ? S : scale(mix(DARK, P, 0.35), 1);
          if (!line && (x + y) % 8 === 4) c = scale(P, 0.42);
          break;
        }
        default: {
          // БРЫЗГИ НЕОНА: клякса и росчерки
          c = P;
          for (const b of blobs) {
            const dx = x - b.x;
            const dy = y - b.y;
            if (dx * dx + dy * dy < b.r * b.r) {
              c = S;
              break;
            }
          }
          for (const s of streaks) {
            if (((x * s.k + y + Math.floor(s.off)) % 19 + 19) % 19 === 0) c = mix(c, S, 0.8);
          }
          break;
        }
      }
      const i = (y * N + x) * 4;
      d[i] = Math.max(0, Math.min(255, c[0]));
      d[i + 1] = Math.max(0, Math.min(255, c[1]));
      d[i + 2] = Math.max(0, Math.min(255, c[2]));
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const texCache = new Map<string, THREE.CanvasTexture>();

/** Текстура 64x64 (NearestFilter) для заданного объекта кастомизации, кешируется */
export function getSkinTexture(cfg: SkinConfig): THREE.CanvasTexture {
  const key = `${cfg.primary}|${cfg.secondary}|${cfg.pattern}`;
  let t = texCache.get(key);
  if (!t) {
    const canvas = document.createElement('canvas');
    drawSkinPattern(canvas, PALETTE[cfg.primary].hex, PALETTE[cfg.secondary].hex, cfg.pattern);
    t = pixelTexture(canvas);
    texCache.set(key, t);
  }
  return t;
}

/** Канвас-превью узора (для панели кастомизации) */
export function makePreviewCanvas(primary: number, secondary: number, pattern: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  drawSkinPattern(c, PALETTE[primary].hex, PALETTE[secondary].hex, pattern);
  return c;
}
