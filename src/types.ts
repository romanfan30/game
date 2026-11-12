import type * as THREE from 'three';
// Общие типы и константы проекта (раздел 2 спецификации)

/** Состояние игрового экрана / конечного автомата */
export type ScreenState = 'boot' | 'hub' | 'playing' | 'paused' | 'dead' | 'complete' | 'customizer';

/** Уровни: 1 — Метрополитен, 2 — Кислотный цех, 3 — Арена Босса */
export type LevelId = 1 | 2 | 3;

/** Слоты экипировки: 1 — Кибер-ПП, 2 — Нож-бабочка, 3 — Только перчатки */
export type WeaponSlot = 1 | 2 | 3;

/** Объекты кастомизации */
export type CustomTarget = 'player' | 'board' | 'gun' | 'knife';

/** Настройка одного объекта: индексы палитры (0..11) и номер узора (0..6) */
export interface SkinConfig {
  primary: number;
  secondary: number;
  pattern: number;
}

export type CustomConfig = Record<CustomTarget, SkinConfig>;

export interface LevelRecord {
  score: number;
  rank: string;
}

export interface SaveData {
  custom: CustomConfig;
  records: Record<'1' | '2' | '3', LevelRecord | null>;
  bossDefeated: boolean;
}

export type EnemyType = 'raver' | 'sniper' | 'robot' | 'drone';

export interface SpawnSpec {
  type: EnemyType;
  x: number;
  y: number;
  z: number;
}

/** Волна/зона спавна: активируется при входе игрока в радиус */
export interface ZoneSpec {
  id: string;
  x: number;
  z: number;
  radius: number;
  spawns: SpawnSpec[];
}

export type GrindStyle = '50-50' | 'boardslide' | 'nosegrind' | 'slavslide';

export const GRIND_STYLE_NAMES: Record<GrindStyle, string> = {
  '50-50': '50-50 ГРАЙНД',
  boardslide: 'БОРДСЛАЙД',
  nosegrind: 'НОУЗГРАЙНД',
  slavslide: 'СЛАВЯНСКИЙ СЛАЙД',
};

export interface RankThresholds {
  S: number;
  A: number;
  B: number;
  C: number;
}

/** Значения по умолчанию для кастомизации */
export const DEFAULT_CUSTOM: CustomConfig = {
  player: { primary: 3, secondary: 2, pattern: 1 },
  board: { primary: 1, secondary: 7, pattern: 4 },
  gun: { primary: 6, secondary: 0, pattern: 5 },
  knife: { primary: 11, secondary: 1, pattern: 2 },
};

export const VERT_TRICKS = ['МЕЛОН-ГРЭБ 360', 'ИНДИ-УЛЁТ', 'ВЕРТУШКА ПЕРУНА 720', 'КРИСТ-ЭЙР БАЗА'] as const;
export const GROUND_FLIPS = ['КИКФЛИП', 'ХИЛФЛИП', '360 ПОП-ШАВИТ', 'ИМПОССИБЛ', 'ХАРДФЛИП'] as const;

/** Источник урона по цели */
export type DamageMethod = 'gun' | 'knife' | 'explosion' | 'bullet' | 'pylon';

/** Пакет урона: передаётся от оружия к цели */
export interface DamageInfo {
  amount: number;
  method: DamageMethod;
  headshot: boolean;
  /** Вмешательство трюка: игрок в полёте или на перилах (для синхро-киллов) */
  fromTrick: boolean;
  point: THREE.Vector3;
}

/** Всё, что можно ранить: враги, пилоны и тело босса */
export interface Targetable {
  readonly id: number;
  readonly radius: number;
  alive: boolean;
  /** Точка «груди» для наведения */
  getCenter(out: THREE.Vector3): THREE.Vector3;
  /** Вернуть true, если точка попала в уязвимую зону (голова/ядро) */
  isWeakPoint(p: THREE.Vector3): boolean;
  /** Применить урон; вернуть true, если цель убита */
  damage(info: DamageInfo): boolean;
}
