import * as THREE from 'three';

/** Внутреннее разрешение PS1-рендера (растягивается CSS-ом на весь экран, image-rendering: pixelated) */
export const INTERNAL_WIDTH = 480;
export const INTERNAL_HEIGHT = 270;

/**
 * Engine: WebGLRenderer 480x270 без сглаживания, сцена, туман, пул точечных источников света.
 * Пул света создаётся один раз: число источников в сцене не меняется, поэтому шейдеры не перекомпилируются.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly lights: THREE.PointLight[] = [];
  readonly ambient: THREE.AmbientLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sun: THREE.DirectionalLight;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(INTERNAL_WIDTH, INTERNAL_HEIGHT, false);
    this.canvas = this.renderer.domElement;
    this.canvas.id = 'game';
    document.body.insertBefore(this.canvas, document.body.firstChild);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0518);
    this.scene.fog = new THREE.FogExp2(0x0b0518, 0.014);

    this.camera = new THREE.PerspectiveCamera(78, INTERNAL_WIDTH / INTERNAL_HEIGHT, 0.1, 400);

    this.ambient = new THREE.AmbientLight(0x3a2a5a, 1.3);
    this.hemi = new THREE.HemisphereLight(0x6ad0ff, 0x1a0a20, 0.9);
    this.sun = new THREE.DirectionalLight(0x9fd8ff, 0.8);
    this.sun.position.set(12, 24, -10);
    this.scene.add(this.ambient, this.hemi, this.sun);

    for (let i = 0; i < 6; i++) {
      const pl = new THREE.PointLight(0xffffff, 0, 30, 1.6);
      this.lights.push(pl);
      this.scene.add(pl);
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Проекция мировой точки в экранные координаты (CSS px) для HUD */
  project(v: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const p = v.clone().project(this.camera);
    const x = (p.x + 1) * 0.5 * window.innerWidth;
    const y = (1 - p.y) * 0.5 * window.innerHeight;
    const visible = p.z > -1 && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    return { x, y, visible };
  }
}
