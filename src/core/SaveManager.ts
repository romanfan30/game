import { CustomConfig, CustomTarget, DEFAULT_CUSTOM, SaveData } from '../types';

const KEY = 'cyber-skate-gabber-overdrive-v1';

function defaults(): SaveData {
  return {
    custom: structuredClone(DEFAULT_CUSTOM),
    records: { '1': null, '2': null, '3': null },
    bossDefeated: false,
  };
}

/** Сохранение кастомизации, рекордов и флага победы над боссом в localStorage */
export class SaveManager {
  static load(): SaveData {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      const d = defaults();
      if (parsed.custom) {
        for (const k of Object.keys(d.custom) as CustomTarget[]) {
          const src = parsed.custom[k];
          if (src) d.custom[k] = { ...d.custom[k], ...src };
        }
      }
      if (parsed.records) d.records = { ...d.records, ...parsed.records };
      d.bossDefeated = !!parsed.bossDefeated;
      return d;
    } catch {
      return defaults();
    }
  }

  static save(data: SaveData): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* квота/приватный режим — игра продолжает работать */
    }
  }

  static saveCustom(custom: CustomConfig): void {
    const d = SaveManager.load();
    d.custom = structuredClone(custom);
    SaveManager.save(d);
  }
}
