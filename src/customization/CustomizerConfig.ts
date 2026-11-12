import { CustomConfig, CustomTarget, SkinConfig } from '../types';

/**
 * Состояние кастомизации (визуальное, без влияния на урон и скорость).
 * Сохранение на диск делает SaveManager через подписку на onChange (см. main.ts).
 */
export class CustomizerConfig {
  private listeners = new Set<(target: CustomTarget, cfg: SkinConfig) => void>();

  constructor(public data: CustomConfig) {}

  get(target: CustomTarget): SkinConfig {
    return this.data[target];
  }

  set(target: CustomTarget, patch: Partial<SkinConfig>): void {
    this.data[target] = { ...this.data[target], ...patch };
    for (const fn of this.listeners) fn(target, this.data[target]);
  }

  onChange(fn: (target: CustomTarget, cfg: SkinConfig) => void): void {
    this.listeners.add(fn);
  }

  snapshot(): CustomConfig {
    return structuredClone(this.data);
  }
}
