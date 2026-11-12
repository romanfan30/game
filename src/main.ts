import './style.css';
import * as THREE from 'three';
import { Engine } from './core/Engine';
import { InputManager } from './core/InputManager';
import { AudioGabber } from './core/AudioGabber';
import { SaveManager } from './core/SaveManager';
import { CustomizerConfig } from './customization/CustomizerConfig';
import { PlayerModel, ModelState } from './player/PlayerModel';
import { SkaterController, SkaterInput } from './player/SkaterController';
import { CameraController } from './player/CameraController';
import { WeaponSystem, WeaponHooks } from './player/WeaponSystem';
import { ComboSystem, GUN_CALLOUTS, KNIFE_CALLOUTS, ACID_CALLOUT, TRICK_CALLOUTS, RANK_TEXT, pick, rankFor } from './combat/ComboSystem';
import { EnemyEnv, EnemyManager, Enemy } from './combat/EnemyManager';
import { ProjectileManager } from './combat/ProjectileManager';
import { ClubVFX } from './world/ClubVFX';
import { Collider } from './world/Collider';
import { TrickObjects } from './world/TrickObjects';
import { BossDJArchon, BassPylon, BossPhase } from './enemies/BossDJArchon';
import { HubLevel, CUSTOM_RADIUS, CUSTOM_ZONE } from './world/HubLevel';
import { LevelData, makeEnemy, makeTrackMaterials, resetWorld, buildLevel1, buildLevel2, buildBossArena, BossArena, TrackMaterials } from './world/LevelBuilder';
import { HUD } from './ui/HUD';
import { CustomizerUI } from './ui/CustomizerUI';
import { DamageInfo, LevelId, SaveData, Targetable, WeaponSlot, ZoneSpec, GRIND_STYLE_NAMES } from './types';

type Mode = 'boot' | 'hub' | 'level' | 'boss';
type State = 'boot' | 'hub' | 'playing' | 'paused' | 'dead' | 'complete' | 'customizer';

const PHASE_NAMES: Record<BossPhase, string> = {
  1: 'ФАЗА 1: ЛАЗЕРНАЯ ВЕРТУШКА И ЩИТЫ БАСА',
  2: 'ФАЗА 2: ПОЛ — ЭТО КИСЛОТНЫЙ КРИНЖ!',
  3: 'ФАЗА 3: 220 BPM SPEEDCORE OVERDRIVE',
};

/** Главный класс игры: экраны, уровни, связка систем */
class Game {
  readonly engine = new Engine();
  readonly input = new InputManager(this.engine.canvas);
  readonly audio = new AudioGabber();
  readonly col = new Collider();
  readonly vfx: ClubVFX;
  readonly save: SaveData = SaveManager.load();
  readonly cfg = new CustomizerConfig(this.save.custom);
  readonly model = new PlayerModel(this.save.custom);
  readonly skater = new SkaterController();
  readonly cam: CameraController;
  readonly combo = new ComboSystem();
  readonly shots: ProjectileManager;
  readonly enemies: EnemyManager;
  readonly weapon: WeaponSystem;
  readonly hud: HUD;
  readonly customUI: CustomizerUI;
  readonly mats: TrackMaterials = makeTrackMaterials();
  readonly world = new THREE.Group();
  tricks: TrickObjects;
  hub: HubLevel | null = null;
  level: LevelData | null = null;
  arena: BossArena | null = null;
  boss: BossDJArchon | null = null;
  mode: Mode = 'boot';
  state: State = 'boot';
  currentLevel: LevelId = 1;
  time = 0;
  private beatPulse = 0;
  private hitStop = 0;
  private slowT = 0;
  private slowStarted = false;
  private triggeredZones = new Set<string>();
  private trophy: THREE.Group | null = null;
  private hurtSfxT = 0;
  private customSuppressed = false;
  private readonly env: EnemyEnv;
  private readonly tmp = new THREE.Vector3();

  constructor() {
    const scene = this.engine.scene;
    scene.add(this.world);
    scene.add(this.model.root);
    this.vfx = new ClubVFX(scene, this.engine.lights);
    this.tricks = new TrickObjects(this.world);
    this.cam = new CameraController(this.engine.camera);
    this.shots = new ProjectileManager(scene, this.vfx);

    const uiRoot = document.getElementById('ui') as HTMLElement;
    this.customUI = new CustomizerUI(
      uiRoot,
      this.cfg,
      (slot) => this.previewSlot(slot),
      () => this.closeCustomizer(),
    );
    this.hud = new HUD(uiRoot, this.customUI.panel);

    const self = this;
    this.env = {
      get time() {
        return self.time;
      },
      scene,
      player: this.skater,
      col: this.col,
      vfx: this.vfx,
      audio: this.audio,
      shots: this.shots,
      hurtPlayer: (amount, reason) => this.hurt(amount, reason),
      floorAt: (x, z, ref) => this.col.groundAt(x, z, ref, 3)?.height ?? 0,
      explode: (c, r, d, s) => this.enemies.explode(c, r, d, s),
    };

    this.enemies = new EnemyManager(scene, () => this.env);
    this.enemies.onKill = (e, info) => this.onEnemyKilled(e, info);

    const hooks: WeaponHooks = {
      onShot: () => this.audio.playShot(),
      onHit: (t, info, killed) => this.onWeaponHit(t, info, killed),
      onEmpty: () => this.audio.playReload(),
      onReloadStart: () => this.audio.playReload(),
      onReloadDone: () => this.audio.playReload(),
      onKnifeSwing: () => this.audio.playKnifeWhoosh(),
      onKnifeHit: () => this.audio.playKnifeHit(),
      onFlex: (grindOrRamp) => this.combo.flex(grindOrRamp) && this.audio.playFlex(),
      onSlot: (slot) => this.hud.setSlot(slot),
    };
    this.weapon = new WeaponSystem({
      camera: this.cam,
      model: this.model,
      skater: this.skater,
      col: this.col,
      vfx: this.vfx,
      shots: this.shots,
      targets: () => this.targets(),
      hooks,
    });

    this.wireSkater();
    this.wireCombo();
    this.wireAudio();
    this.cfg.onChange(() => {
      this.model.applySkins(this.cfg.data);
      SaveManager.saveCustom(this.cfg.snapshot());
    });
    this.input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing') this.pause();
    };
    // Хаб уже стоит за стартовой табличкой: клик включает звук и отправляет в катание
    this.loadHub();
    this.showBoot();
  }

  // ---------- Подписки ----------

  private wireSkater(): void {
    const s = this.skater;
    s.events = {
      onOllie: () => this.audio.playOllie(),
      onFlip: (name) => {
        this.audio.playFlip();
        this.combo.ollieFlip(name);
      },
      onAirTrick: (name) => {
        this.audio.playFlip();
        this.hud.callout(name, 'trick');
      },
      onGrindStart: (_rail, style, isNew) => {
        this.audio.playGrindStart();
        this.audio.setGrinding(true);
        if (isNew) this.combo.railOrRamp(GRIND_STYLE_NAMES[style]);
      },
      onGrindEnd: (kind) => {
        this.audio.setGrinding(false);
        if (kind === 'jump') this.hud.callout('ПРЫЖОК С ПЕРИЛ!', 'trick');
      },
      onGrindTick: () => this.combo.grindPoints(30),
      onGrindSpark: (p) => this.vfx.burst(p, 0xffcc33, 2, 4, 0.22, 0.08, 10),
      onBrakeSpark: (p) => this.vfx.burst(p, 0xffaa33, 3, 3, 0.2, 0.07, 10),
      onRampLaunch: (name) => {
        this.audio.playOllie();
        this.combo.railOrRamp(name);
      },
      onVertLand: (name) => this.hud.callout(name, 'trick'),
      onLand: (impact) => {
        this.audio.playLand(impact);
        this.combo.landed();
      },
      onAcid: (p) => {
        this.audio.playAcidSplash();
        this.vfx.burst(p, 0x39ff14, 30, 10, 0.6, 0.14, 12);
        this.hud.callout(ACID_CALLOUT, 'kill');
        this.hurt(25, 'КИСЛОТА');
      },
    };
  }

  private wireCombo(): void {
    this.combo.onCallout = (text, tone) => this.hud.callout(text, tone);
    this.combo.onHeal = () => this.hud.flashSync();
  }

  private wireAudio(): void {
    this.audio.onBeat = (beat) => {
      this.beatPulse = 1;
      this.vfx.onBeat(beat);
    };
  }

  // ---------- Цели и урон ----------

  /** Все цели для оружия: в хабе — манекен, на уровне — живые враги, пилоны и тело босса */
  private targets(): Targetable[] {
    if (this.mode === 'hub') {
      return this.hub && this.hub.dummy.alive ? [this.hub.dummy] : [];
    }
    const list: Targetable[] = [...this.enemies.targets()];
    if (this.boss && this.boss.alive && !this.boss.dying) {
      list.push(this.boss);
      for (const p of this.boss.pylons) if (p.alive) list.push(p);
    }
    return list;
  }

  private onWeaponHit(t: Targetable, info: DamageInfo, killed: boolean): void {
    this.hud.hitMark(killed);
    this.audio.playHitMarker();
    if (killed && t instanceof BassPylon) {
      this.combo.gunKill(false, 'ПИЛОН ПОГАС!');
      this.audio.playEnemyDie();
    }
    if (killed && this.mode === 'hub') this.hud.callout(pick(GUN_CALLOUTS), 'kill');
    if (info.fromTrick) this.hitStop = 0.035;
  }

  /** Смерть врага (включая взрывы и синхро): очки и мемы */
  private onEnemyKilled(_e: Enemy, info: DamageInfo): void {
    this.audio.playEnemyDie();
    const railOrAir = this.skater.grind !== null || !this.skater.grounded;
    if (this.mode === 'hub') {
      if (info.method === 'knife') this.hud.callout(pick(KNIFE_CALLOUTS), 'kill');
      return;
    }
    if (info.method === 'knife') {
      this.combo.knifeKill(pick(KNIFE_CALLOUTS));
      this.audio.playKnifeHit();
    } else if (info.method === 'explosion') {
      this.combo.gunKill(false, 'ЦЕПНАЯ РЕАКЦИЯ!');
    } else {
      this.combo.gunKill(info.headshot, pick(GUN_CALLOUTS));
    }
    if (info.fromTrick) {
      this.combo.synchro(info.method === 'knife', railOrAir);
      this.hud.flashSync();
      this.audio.playSynchro();
    }
  }

  /** Урон игроку: HP, вспышка, звук и смерть */
  private hurt(amount: number, reason: string): void {
    if (this.state !== 'playing' || this.mode === 'hub') return;
    const dead = this.combo.hurt(amount);
    this.hud.setHP(this.combo.hp, 100);
    this.hud.flashHurt();
    if (this.time > this.hurtSfxT) {
      this.hurtSfxT = this.time + 0.3;
      this.audio.playPlayerHurt();
      this.hud.showToast(`-${Math.round(amount)} ${reason}`, 1.2);
    }
    if (dead) this.die();
  }

  // ---------- Экраны ----------

  private showBoot(): void {
    this.state = 'boot';
    this.hud.setHUDVisible(false);
    this.hud.showScreen({
      title: 'КИБЕР-СКЕЙТ ПРОТИВ ЯЩЕРОВ',
      lines: ['GABBER OVERDRIVE 1999'],
      buttons: [{ label: '[ КЛИКНИ, ЧТОБЫ ВРУБИТЬ 190 BPM ГАББЕР И ВКАТИТЬСЯ В ИГРУ ]', onClick: () => this.start() }],
    });
  }

  private start(): void {
    this.audio.init();
    this.audio.setBpm(190);
    this.input.requestLock();
    this.hud.hideScreen();
    this.hud.setHUDVisible(true);
    this.state = 'hub';
    this.hud.showToast('ГРИМЁРКА: ЕДЬ К ПОРТАЛАМ, ВЕРСТАК — C', 4);
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.exitLock();
    this.hud.showScreen({
      title: 'ПАУЗА',
      lines: ['Курс и трюки заморожены.'],
      buttons: [
        { label: 'ПРОДОЛЖИТЬ', onClick: () => this.resume() },
        { label: 'ЗАНОВО', onClick: () => this.loadLevel(this.currentLevel) },
        { label: 'В ГРИМЁРКУ', onClick: () => this.loadHub() },
      ],
    });
  }

  private resume(): void {
    this.state = 'playing';
    this.hud.hideScreen();
    this.input.requestLock();
  }

  private die(): void {
    this.state = 'dead';
    this.audio.playDeath();
    this.input.exitLock();
    this.hud.bigMessage('ПОТЕРЯЛ ВАЙБ — ЯЩЕРЫ ЗАДУШНИЛИ!', 99);
    this.hud.showScreen({
      title: 'ПОТЕРЯЛ ВАЙБ',
      lines: ['ЯЩЕРЫ ЗАДУШНИЛИ!', '[ R — МГНОВЕННО ВКАТИТЬСЯ ЗАНОВО ]', '[ ESC — В ГРИМЁРКУ ]'],
      cls: 'lose',
      buttons: [
        { label: 'ВКАТИТЬСЯ ЗАНОВО', onClick: () => this.loadLevel(this.currentLevel) },
        { label: 'В ГРИМЁРКУ', onClick: () => this.loadHub() },
      ],
    });
  }

  private completeAt = 0;
  private fireworkT = 0;

  private completeLevel(victory: boolean): void {
    if (this.state === 'complete' || !this.level) return;
    const score = this.combo.score;
    const rank = rankFor(score, this.level.ranks);
    const id = this.currentLevel;
    const prev = this.save.records[String(id) as '1' | '2' | '3'];
    if (!prev || score > prev.score) {
      this.save.records[String(id) as '1' | '2' | '3'] = { score, rank };
    }
    if (victory) this.save.bossDefeated = true;
    SaveManager.save(this.save);
    this.state = 'complete';
    this.completeAt = this.time + 6;
    this.fireworkT = 0;
    this.input.exitLock();
    this.hud.hideBoss();
    this.hud.bigMessage(victory ? 'ПОБЕДА!' : 'ФИНИШ!', 3);
    this.hud.showScreen({
      title: victory ? 'ПОБЕДА НАД АРХОНТОМ' : this.level.title,
      lines: [`СЧЁТ: ${score.toString().padStart(6, '0')}`, RANK_TEXT[rank], 'ВОЗВРАТ В ГРИМЁРКУ...'],
      rank,
      buttons: [
        { label: 'В ГРИМЁРКУ', onClick: () => this.loadHub() },
        { label: 'ЕЩЁ РАЗ', onClick: () => this.loadLevel(this.currentLevel) },
      ],
    });
  }

  /** Фейерверк над финишем; после паузы игрок возвращается в Гримёрку */
  private updateComplete(dt: number): void {
    this.fireworkT -= dt;
    if (this.fireworkT <= 0) {
      this.fireworkT = 0.4;
      const c = this.skater.pos;
      const colors = [0xff0033, 0xffe600, 0x39ff14, 0x00e5ff, 0xff00d4];
      const at = new THREE.Vector3(c.x + (Math.random() - 0.5) * 30, c.y + 12 + Math.random() * 10, c.z + (Math.random() - 0.5) * 30);
      this.vfx.burst(at, colors[Math.floor(Math.random() * colors.length)], 40, 9, 1.2, 0.2, 6);
      this.audio.playExplosion(0.6);
    }
    if (this.time >= this.completeAt) this.loadHub();
  }

  // ---------- Загрузка миров ----------

  /** Очистка мира и врагов; создание нового TrickObjects на каждый мир */
  private resetWorldState(): void {
    resetWorld(this.col, this.world, this.tricks);
    this.col.surfaces.length = 0;
    this.col.walls.length = 0;
    this.col.bound = null;
    this.tricks = new TrickObjects(this.world);
    this.enemies.clear();
    this.shots.clearShots();
    this.hub = null;
    this.level = null;
    this.arena = null;
    this.boss = null;
    this.trophy = null;
    this.triggeredZones.clear();
    this.slowT = 0;
    this.slowStarted = false;
    this.skater.setWorld(this.col, this.tricks);
  }

  private placePlayer(pos: THREE.Vector3, heading: number): void {
    this.skater.reset(pos, heading);
    this.combo.reset();
    this.weapon.reset();
    this.model.setSlot(this.weapon.slot);
  }

  private loadHub(): void {
    this.resetWorldState();
    this.mode = 'hub';
    this.customSuppressed = false;
    this.hub = new HubLevel(this.world, this.col, this.tricks, this.vfx, this.mats, this.save.records);
    this.skater.setWorld(this.col, this.tricks);
    this.placePlayer(this.hub.spawnPoint(), 0);
    this.audio.setFilterOpen(false);
    this.vfx.intensity = 1;
    this.state = 'hub';
    this.hud.hideBoss();
    // Трофей на верстаке после победы над боссом
    if (this.save.bossDefeated) {
      const g = new THREE.Group();
      const gold = new THREE.MeshLambertMaterial({ color: 0xffd700, emissive: 0xaa7700, emissiveIntensity: 0.6 });
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.2, 0.7, 8), gold);
      cup.position.y = 0.35;
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), gold);
      star.position.y = 0.9;
      g.add(cup, star);
      g.position.set(CUSTOM_ZONE.x + 0.8, 1.2, CUSTOM_ZONE.y - 2.2);
      this.world.add(g);
      this.trophy = g;
    }
    this.highlightNextGate();
    this.hub.dummy.onDown = () => this.hud.callout(pick(TRICK_CALLOUTS), 'trick');
  }

  private highlightNextGate(): void {
    if (!this.hub) return;
    const r = this.save.records;
    const next: LevelId = !r['1'] ? 1 : !r['2'] ? 2 : 3;
    this.hub.highlightNext(next);
  }

  private loadLevel(id: LevelId): void {
    this.resetWorldState();
    this.currentLevel = id;
    this.customSuppressed = false;
    if (id === 1 || id === 2) {
      this.mode = 'level';
      this.level = id === 1
        ? buildLevel1(this.world, this.col, this.tricks, this.vfx, this.mats)
        : buildLevel2(this.world, this.col, this.tricks, this.vfx, this.mats);
    } else {
      this.mode = 'boss';
      this.arena = buildBossArena(this.world, this.col, this.tricks, this.vfx, this.mats, {
        onSay: (t) => this.hud.bossLine(t),
        onPhase: (p) => this.onBossPhase(p),
        onBpm: (bpm) => this.audio.setBpm(bpm),
        onDefeat: () => this.completeLevel(true),
        onSpawn: (t, p) => this.enemies.add(makeEnemy(t, p), p),
        onShieldBreak: () => {
          this.hud.bigMessage('ЩИТ ЛОПНУЛ!', 2);
          this.audio.playExplosion(1);
        },
        onElectric: (on) => {
          if (on) this.hud.bigMessage('ПОЛ ЗАРЯЖЕН! ЗАПРЫГИВАЙ НА ПЛАТФОРМЫ', 2);
        },
        scene: this.engine.scene,
      });
      this.level = this.arena.data;
      this.boss = this.arena.boss;
      this.boss.phase = 1;
    }
    this.skater.setWorld(this.col, this.tricks);
    this.placePlayer(this.level!.spawn, this.level!.heading);
    this.audio.setFilterOpen(true);
    this.audio.setBpm(this.level!.bpm);
    this.vfx.intensity = 1;
    this.state = 'playing';
    this.hud.hideScreen();
    this.hud.setHUDVisible(true);
    this.hud.showLevelTitle(this.level!.title);
    this.input.requestLock();
    if (this.boss) {
      this.hud.showBoss(1, PHASE_NAMES[1]);
      this.hud.bossLine('ЙОУ, СМОТРИТЕ, КАКОЙ-ТО ЧЕЛ НА ДОСКЕ ПРИПЁРСЯ! АРХОНТ, ВРУБАЙ МЯСОРУБКУ!');
    }
    this.audio.setWheel(0, true);
  }

  private onBossPhase(p: BossPhase): void {
    this.hud.showBoss(this.boss ? this.boss.hp / 2500 : 1, PHASE_NAMES[p]);
    this.hud.bigMessage(PHASE_NAMES[p], 2.5);
    this.vfx.intensity = p === 3 ? 2.5 : 1;
  }

  // ---------- Мастерская ----------

  private openCustomizer(): void {
    this.state = 'customizer';
    this.input.exitLock();
    this.skater.frozen = true;
    this.cam.lockOrbit = true;
    this.customUI.open();
    this.hud.showCustomizer(true);
  }

  private closeCustomizer(): void {
    this.state = 'hub';
    this.skater.frozen = false;
    this.cam.lockOrbit = false;
    this.customUI.close();
    this.hud.showCustomizer(false);
    this.input.requestLock();
    this.customSuppressed = true;
  }

  private previewSlot(slot: WeaponSlot): void {
    this.weapon.setSlot(slot);
  }

  // ---------- Главный цикл ----------

  update(dt: number): void {
    this.time += dt;
    this.beatPulse = Math.max(0, this.beatPulse - dt * 6);
    this.audio.update(dt);

    let simDt = dt;
    if (this.slowT > 0) {
      this.slowT -= dt;
      simDt = dt * 0.2;
      if (this.slowT <= 0) this.slowT = 0;
    }
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      simDt = 0;
    }

    // Ввод
    const playing = this.state === 'playing' || this.state === 'hub';
    const sk: SkaterInput = {
      fwd: this.input.isDown('KeyW') && playing,
      back: this.input.isDown('KeyS') && playing,
      left: this.input.isDown('KeyA') && playing,
      right: this.input.isDown('KeyD') && playing,
      space: this.input.wasPressed('Space') && playing,
      camYaw: this.cam.camYaw(this.skater.heading),
    };
    const aimHeld = this.input.isDown('Mouse2') && playing;

    // Меню и переключения
    if (this.input.wasPressed('Escape')) this.onEscape();
    if (this.input.wasPressed('KeyM')) this.hud.showToast(`ГРОМКОСТЬ ГАББЕРА: ${this.audio.cycleMusicVolume()}`);
    if (this.state === 'customizer' && (this.input.wasPressed('Space') || this.input.wasPressed('Escape'))) this.closeCustomizer();
    if (this.state === 'customizer') this.cam.orbit += (Math.PI - this.cam.orbit) * Math.min(1, dt * 3);
    if (this.state === 'hub' && !this.customSuppressed && this.hub) {
      const dd = Math.hypot(this.skater.pos.x - CUSTOM_ZONE.x, this.skater.pos.z - CUSTOM_ZONE.y);
      if (dd < CUSTOM_RADIUS) this.openCustomizer();
    }
    if (this.state === 'hub' && this.hub) {
      const dd = Math.hypot(this.skater.pos.x - CUSTOM_ZONE.x, this.skater.pos.z - CUSTOM_ZONE.y);
      if (dd > CUSTOM_RADIUS + 1.2) this.customSuppressed = false;
      if (this.input.wasPressed('KeyC') && dd < CUSTOM_RADIUS + 2.5) this.openCustomizer();
    }
    if (this.state === 'dead' && this.input.wasPressed('KeyR')) this.loadLevel(this.currentLevel);

    // Симуляция: только в хабе, на уровне и в верстаке (скейт замедляется)
    const simulate = this.state === 'playing' || this.state === 'hub' || this.state === 'customizer';
    if (simulate && this.mode !== 'boot') {
      this.skater.update(this.state === 'customizer' ? dt : simDt, sk, this.time);
      this.combo.frozen = this.skater.isGrinding();
      this.combo.tick(simDt);

      // Оружие: в хабе и на уровнях; в верстаке отключено
      if (this.state !== 'customizer') {
        this.weapon.update({
          fireHeld: this.input.isDown('Mouse0') && playing,
          firePressed: this.input.wasPressed('Mouse0') && playing,
          aimHeld,
          reloadPressed: this.input.wasPressed('KeyR') && playing,
          inTrick: this.skater.inTrick(),
          grindOrRamp: this.skater.grind !== null || !this.skater.grounded,
          dt: simDt,
        });
        if (this.input.wasPressed('Digit1')) this.weapon.setSlot(1);
        if (this.input.wasPressed('Digit2') || this.input.wasPressed('KeyQ')) this.weapon.setSlot(2);
        if (this.input.wasPressed('Digit3')) this.weapon.setSlot(3);
        if (this.input.wheel !== 0) this.weapon.cycleSlot(Math.sign(this.input.wheel));
      }

      if (this.state === 'playing') this.updateLevel();
      if (this.state === 'hub') this.updateHub(simDt);
      this.enemies.update(simDt, this.env);
      this.shots.updateShots(simDt, this.skater.pos.clone().add(new THREE.Vector3(0, 1, 0)), this.col, 6 * simDt);
      if (this.boss && this.boss.alive) {
        this.boss.update(this.boss.dying ? dt : simDt, this.env);
        if (this.boss.dying && !this.slowStarted) {
          this.slowStarted = true;
          this.slowT = 2.0;
        }
      }
    }
    // Визуальные параметры модели
    this.model.root.position.copy(this.skater.pos);
    this.model.root.rotation.y = this.skater.heading;
    this.model.root.rotation.z = 0;
    this.model.setSpin(this.skater.bodySpin, this.skater.boardSpin);
    const st: ModelState = {
      speed: this.skater.horizontalSpeed(),
      grounded: this.skater.grounded,
      airborne: !this.skater.grounded,
      grindStyle: this.skater.grind?.style ?? null,
      lean: this.skater.lean,
      pushing: this.skater.pushing,
      dt,
      time: this.time,
    };
    this.model.update(dt, this.time, st);
    if (this.skater.grind) this.audio.setWheel(0, false);
    else this.audio.setWheel(this.skater.horizontalSpeed(), this.skater.grounded);

    // Камера
    const mx = this.state === 'playing' || this.state === 'hub' ? this.input.mouseDX : 0;
    const my = this.state === 'playing' || this.state === 'hub' ? this.input.mouseDY : 0;
    this.cam.update(dt, this.skater, aimHeld && this.state === 'playing', mx, my, this.col);

    // Эффекты
    this.vfx.update(dt, this.time);
    this.tricks.update(this.time, this.beatPulse);
    this.shots.update(dt);

    // HUD
    this.updateHud(dt);
    this.input.endFrame();
    this.engine.render();
  }

  private onEscape(): void {
    if (this.state === 'customizer') {
      this.closeCustomizer();
      return;
    }
    if (this.state === 'playing') {
      this.pause();
      return;
    }
    if (this.state === 'paused') {
      this.resume();
      return;
    }
    if (this.state === 'dead') {
      this.loadHub();
      return;
    }
  }

  /** Логика уровня: зоны спавна, финиш, попадание рельсов/рамп */
  private updateLevel(): void {
    const p = this.skater.pos;
    const lv = this.level;
    if (!lv) return;
    for (const z of lv.zones) {
      if (this.triggeredZones.has(z.id)) continue;
      const d = Math.hypot(p.x - z.x, p.z - z.z);
      if (d < z.radius) this.spawnZone(z);
    }
    if (lv.finish && p.distanceTo(lv.finish.pos) < lv.finish.radius) {
      this.completeLevel(false);
      return;
    }
  }

  private spawnZone(z: ZoneSpec): void {
    this.triggeredZones.add(z.id);
    for (const s of z.spawns) {
      const pos = new THREE.Vector3(s.x, s.y, s.z);
      this.enemies.add(makeEnemy(s.type, pos), pos);
    }
  }

  private updateHub(simDt: number): void {
    if (!this.hub) return;
    this.hub.update(simDt, this.time);
    for (const portal of this.hub.portals) {
      const dx = this.skater.pos.x - portal.pos.x;
      const dz = this.skater.pos.z - portal.pos.z;
      if (Math.hypot(dx, dz) < portal.radius && this.skater.pos.y < 2) {
        this.loadLevel(portal.level);
        return;
      }
    }
  }

  /** Экранные подсказки и прицел */
  private updateHud(dt: number): void {
    if (this.state === 'boot') return;
    this.hud.setHUDVisible(true);
    this.hud.setHP(this.combo.hp, 100);
    this.hud.setScore(this.combo.score, this.combo.mult, this.combo.timer / 4, this.beatPulse);
    this.hud.setAmmo(this.weapon.ammo, this.weapon.isReloading());
    this.hud.setSlot(this.weapon.slot);
    this.hud.setSpeed(Math.abs(this.skater.speedFwd()) * 3.6);
    this.hud.setCrosshair(this.cam.aimBlend > 0.55);

    // Ромб захвата: автонаводка без ПКМ
    const t = this.weapon.autoTarget;
    if (t && this.weapon.slot === 1 && this.cam.aimBlend < 0.2) {
      const c = t.getCenter(this.tmp);
      const pr = this.engine.project(c);
      if (pr.visible) this.hud.setLock(pr.x, pr.y);
      else this.hud.hideLock();
    } else {
      this.hud.hideLock();
    }

    // Подсказка рельса и подсветка
    this.tricks.highlightNear(this.skater.pos);
    const hint = this.tricks.hintAt(this.skater.pos, 3.5);
    if (hint && !this.skater.grind && this.skater.grounded) {
      const pr = this.engine.project(new THREE.Vector3(hint.x, hint.y, hint.z));
      if (pr.visible) this.hud.setRailHint(pr.x, pr.y, hint.text);
      else this.hud.setRailHint(null, null);
    } else {
      this.hud.setRailHint(null, null);
    }
    this.hud.update(dt);
    if (this.state === 'complete') this.updateComplete(dt);

    if (this.boss && this.boss.alive) {
      this.hud.showBoss(this.boss.hp / 2500, PHASE_NAMES[this.boss.phase]);
    }
  }
}

// ---------- Запуск ----------

const game = new Game();
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  game.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

