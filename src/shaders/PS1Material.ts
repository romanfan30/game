import * as THREE from 'three';

/**
 * PS1 Vertex Snapping: после вычисления gl_Position квантуем вершины на сетку 160x90 (дрожание полигонов).
 * Хук подключается через onBeforeCompile; все материалы используют одну и ту же функцию,
 * поэтому Three.js переиспользует скомпилированную программу (customProgramCacheKey).
 */
const PS1_SNAP_CHUNK = `#include <project_vertex>
vec4 snapPos = gl_Position;
vec2 grid = vec2(160.0, 90.0);
snapPos.xyz = snapPos.xyz / snapPos.w;
snapPos.xy = floor(grid * snapPos.xy) / grid;
snapPos.xyz *= snapPos.w;
gl_Position = snapPos;`;

const ps1Hook = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
  shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', PS1_SNAP_CHUNK);
};

/** Фабрика PS1-материала на основе MeshLambertMaterial (освещённый) */
export function createPS1Material(options: THREE.MeshLambertMaterialParameters = {}): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial(options);
  m.onBeforeCompile = ps1Hook;
  return m;
}

/** PS1-материал без освещения (неон, свечение, эффекты) */
export function createPS1BasicMaterial(options: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial(options);
  m.onBeforeCompile = ps1Hook;
  return m;
}

/** Текстура с NearestFilter и без мипмапов (требование PS1-рендера) */
export function pixelTexture(canvas: HTMLCanvasElement, repeatX = 1, repeatY = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  return t;
}

const lambertCache = new Map<string, THREE.MeshLambertMaterial>();

/** Общий (кешированный) PS1-материал для статичного декора */
export function lambert(color: number, emissive = 0, emissiveIntensity = 1): THREE.MeshLambertMaterial {
  const key = `${color}|${emissive}|${emissiveIntensity}`;
  let m = lambertCache.get(key);
  if (!m) {
    m = createPS1Material({ color, emissive, emissiveIntensity });
    lambertCache.set(key, m);
  }
  return m;
}

const basicCache = new Map<string, THREE.MeshBasicMaterial>();

/** Кешированный unlit-материал (аддитив/неон) */
export function unlit(color: number, opacity = 1, additive = false): THREE.MeshBasicMaterial {
  const key = `${color}|${opacity}|${additive}`;
  let m = basicCache.get(key);
  if (!m) {
    m = createPS1BasicMaterial({
      color,
      transparent: opacity < 1 || additive,
      opacity,
      depthWrite: !(opacity < 1 || additive),
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    basicCache.set(key, m);
  }
  return m;
}
