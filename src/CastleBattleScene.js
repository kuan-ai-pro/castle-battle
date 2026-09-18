import Phaser from 'phaser';
import {
  CASTLE_DAMAGE,
  COMBO_DURATION_MS,
  COMBO_SPEED_MULTIPLIER,
  COMBO_TRIGGER_COUNT,
  COMBO_WINDOW_MS,
  COMEBACK_DAMAGE_MULTIPLIER,
  COMBAT_RADIUS,
  COMBAT_SLOT_COUNT,
  COMBAT_SLOT_RADIUS,
  ENDGAME_HP_THRESHOLD_PERCENT,
  GAME_HEIGHT,
  GAME_WIDTH,
  KNIGHT_DAMAGE,
  KNIGHT_HP,
  KNIGHT_SPEED,
  LEFT_TEAM,
  MAX_CASTLE_HP,
  RESTART_DELAY_SECONDS,
  RIGHT_TEAM,
  SFX_MASTER_VOLUME,
  SPAWN_OFFSET_FROM_CENTER,
  TEAM_CONFIG,
} from './config.js';
import { frameCatalog, sceneAssets } from './assets.js';
import { connectGiftSocket } from './giftSocket.js';
import { soundAssets, soundVariants } from './sounds.js';
import { SpawnQueue } from './spawnQueue.js';

const UI = {
  ink: 0x140d12,
  parchment: 0xffe5a1,
  gold: 0xffc93d,
  goldDark: 0x8c4d10,
  red: 0xb51424,
  redDark: 0x570817,
  blue: 0x145ac4,
  blueDark: 0x082968,
  hp: 0x46cc64,
};

const FORMATION_SLOT_INSET = 18;
const MOCK_DONOR_NAMES = [
  '@Aruzhan',
  '@Dias',
  '@Aigerim',
  '@Nursultan',
  '@Madina',
  '@Alikhan',
  '@Dana',
  '@Miras',
  '@Tomiris',
  '@Sanzhar',
];

export class CastleBattleScene extends Phaser.Scene {
  constructor() {
    super('castle-battle');
  }

  preload() {
    const loadingText = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'ЗАГРУЗКА 0%', {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '34px',
        color: '#ffe5a1',
        stroke: '#140d12',
        strokeThickness: 8,
      })
      .setOrigin(0.5);

    this.load.on('progress', (value) => {
      loadingText.setText(`ЗАГРУЗКА ${Math.round(value * 100)}%`);
    });
    this.load.once('complete', () => loadingText.destroy());

    this.load.image('background', sceneAssets.background);
    Object.entries(sceneAssets.castles).forEach(([color, stages]) => {
      Object.entries(stages).forEach(([stage, url]) => {
        this.load.image(`castle-${color}-${stage}`, url);
      });
    });

    Object.values(frameCatalog).forEach((teamAnimations) => {
      Object.values(teamAnimations).forEach((frames) => {
        frames.forEach(({ key, url }) => this.load.image(key, url));
      });
    });

    Object.entries(soundAssets).forEach(([key, url]) => this.load.audio(key, url));
  }

  create() {
    this.activeKnights = [];
    this.nextKnightId = 1;
    this.nextFormationSlot = { left: 0, right: 0 };
    this.nextEndgameShakeAt = 0;
    this.nextDonorNameIndex = 0;
    this.leftScore = 0;
    this.rightScore = 0;
    this.isRoundOver = false;
    this.roundCountdownEvent = null;
    this.roundResetTimer = null;
    this.roundTimers = new Set();
    this.roundEffectObjects = new Set();
    this.roundEffectTweens = new Set();
    this.pendingDeathKnights = new Set();
    this.activeRoundSounds = new Set();
    this.lastSoundVariant = {};
    this.soundLimiterState = {
      swordHit: this.createSoundLimiter(6),
      castleHit: this.createSoundLimiter(6),
      knightDeath: this.createSoundLimiter(3),
    };
    this.castleSoundSequence = { left: 0, right: 0 };
    this.comboState = {
      left: this.createComboState(),
      right: this.createComboState(),
    };
    this.createKnightAnimations();
    this.createWorld();
    this.createTopUi();
    this.createDebugPanel();
    this.createKeyboardControls();
    this.connectGiftProvider();
  }

  connectGiftProvider() {
    this.giftSpawnQueue = new SpawnQueue({ aggregationWindowMs: 500 });
    this.giftSocket = connectGiftSocket((payload) => {
      if (!this.isRoundOver) this.giftSpawnQueue.push(payload);
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.giftSpawnQueue.clear();
      this.giftSocket.disconnect();
    });
  }

  flushGiftSpawnQueue() {
    if (!this.giftSpawnQueue) return;

    this.giftSpawnQueue.drainReady().forEach((batch) => {
      const playSpawnSound = batch.count === 1;
      for (let index = 0; index < batch.count; index += 1) {
        this.spawnKnight(batch.team, batch.donor, { playSpawnSound });
      }
    });
  }

  createComboState() {
    return {
      spawnTimestamps: [],
      isActive: false,
      activatedAt: 0,
      endsAt: 0,
      totalSpawns: 0,
      comboValue: 0,
      lastDonors: [],
    };
  }

  createSoundLimiter(maxConcurrent) {
    return {
      maxConcurrent,
      activeCount: 0,
      nextAllowedAt: 0,
      cooldownMinMs: 80,
      cooldownMaxMs: 120,
    };
  }

  scheduleRoundCallback(delay, callback) {
    let timer = null;
    timer = this.time.delayedCall(delay, (...args) => {
      this.roundTimers.delete(timer);
      callback(...args);
    });
    this.roundTimers.add(timer);
    return timer;
  }

  trackRoundTimer(timer) {
    this.roundTimers.add(timer);
    return timer;
  }

  cancelRoundTimer(timer) {
    if (!timer) return;
    timer.remove(false);
    this.roundTimers.delete(timer);
  }

  trackRoundEffect(object) {
    this.roundEffectObjects.add(object);
    return object;
  }

  trackRoundEffectTween(tween) {
    this.roundEffectTweens.add(tween);
    return tween;
  }

  clearRoundAsyncWork() {
    this.roundTimers.forEach((timer) => timer.remove(false));
    this.roundTimers.clear();

    this.pendingDeathKnights.forEach((knight) => {
      if (knight.deathAnimationHandler && knight.sprite) {
        knight.sprite.off('animationcomplete', knight.deathAnimationHandler);
      }
      knight.deathAnimationHandler = null;
    });
    this.pendingDeathKnights.clear();

    this.roundEffectTweens.forEach((tween) => tween.stop());
    this.roundEffectTweens.clear();
    this.roundEffectObjects.forEach((object) => {
      if (object?.active) object.destroy();
    });
    this.roundEffectObjects.clear();

    this.activeRoundSounds.forEach((sound) => {
      sound.stop();
      sound.destroy();
    });
    this.activeRoundSounds.clear();
    Object.values(this.soundLimiterState).forEach((limiter) => {
      limiter.activeCount = 0;
      limiter.nextAllowedAt = 0;
    });
  }

  reserveLimitedSoundSlot(category) {
    const limiter = this.soundLimiterState[category];
    if (!limiter) return 1;

    const now = this.time.now;
    if (now < limiter.nextAllowedAt || limiter.activeCount >= limiter.maxConcurrent) return null;

    const loadRatio = limiter.activeCount / limiter.maxConcurrent;
    const volumeScale = Math.max(0.65, 1 - loadRatio * 0.35);
    limiter.activeCount += 1;
    limiter.nextAllowedAt = now + Phaser.Math.Between(limiter.cooldownMinMs, limiter.cooldownMaxMs);
    return volumeScale;
  }

  releaseLimitedSoundSlot(category) {
    const limiter = this.soundLimiterState[category];
    if (!limiter) return;
    limiter.activeCount = Math.max(0, limiter.activeCount - 1);
  }

  playTrackedSound(key, {
    volume = 1,
    rate = 1,
    onComplete = null,
    limiterCategory = null,
  } = {}) {
    if (!this.cache.audio.exists(key)) return null;

    const sound = this.sound.add(key);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      this.activeRoundSounds.delete(sound);
      if (limiterCategory) this.releaseLimitedSoundSlot(limiterCategory);
    };
    this.activeRoundSounds.add(sound);
    sound.once('complete', () => {
      cleanup();
      if (onComplete) onComplete();
      sound.destroy();
    });
    sound.once('destroy', cleanup);
    sound.play({
      volume: Phaser.Math.Clamp(SFX_MASTER_VOLUME * volume, 0, 1),
      rate,
    });
    return sound;
  }

  playRandomVariant(group, { volume = 1, varyRate = true } = {}) {
    const variants = soundVariants[group];
    if (!variants?.length) return null;

    const loadVolumeScale = this.reserveLimitedSoundSlot(group);
    if (loadVolumeScale === null) return null;

    const previousKey = this.lastSoundVariant[group];
    const availableVariants = variants.length > 1
      ? variants.filter((key) => key !== previousKey)
      : variants;
    const key = Phaser.Utils.Array.GetRandom(availableVariants);
    this.lastSoundVariant[group] = key;

    const sound = this.playTrackedSound(key, {
      volume: volume * loadVolumeScale * Phaser.Math.FloatBetween(0.9, 1.1),
      rate: varyRate ? Phaser.Math.FloatBetween(0.9, 1.1) : 1,
      limiterCategory: group,
    });
    if (!sound) this.releaseLimitedSoundSlot(group);
    return sound;
  }

  playCastleStageSoundSequence(castleTeam) {
    const sequenceId = ++this.castleSoundSequence[castleTeam];
    const canContinue = () => (
      this.castleSoundSequence[castleTeam] === sequenceId
      && !this.isRoundOver
      && !this.castles[castleTeam].destroyed
    );
    const teamCallKey = castleTeam === 'left' ? 'go-shymkent' : 'go-almaty';

    this.playTrackedSound('castle-crack', {
      volume: 0.9,
      onComplete: () => {
        if (!canContinue()) return;
        this.playTrackedSound(teamCallKey, {
          volume: 0.95,
          onComplete: () => {
            if (canContinue()) this.playTrackedSound('war-cry', { volume: 0.95 });
          },
        });
      },
    });
  }

  createWorld() {
    this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'background').setDisplaySize(GAME_WIDTH, GAME_HEIGHT);

    const castleSize = 470;
    this.castleBaseY = GAME_HEIGHT * 0.575;
    const castleY = this.castleBaseY - castleSize / 2;
    const leftCastleX = GAME_WIDTH * 0.2;
    const rightCastleX = GAME_WIDTH * 0.8;

    const leftCastleSprite = this.add
      .image(leftCastleX, castleY, 'castle-red-100')
      .setDisplaySize(castleSize, castleSize);
    const rightCastleSprite = this.add
      .image(rightCastleX, castleY, 'castle-blue-100')
      .setDisplaySize(castleSize, castleSize);

    this.castles = {
      left: {
        team: 'left',
        color: 'red',
        hp: MAX_CASTLE_HP,
        stage: 100,
        destroyed: false,
        sprite: leftCastleSprite,
        baseX: leftCastleX,
        baseY: castleY,
        hitShakeTween: null,
        hitFlashTimer: null,
        lastHitDonor: null,
        isEndgamePhase: false,
        endgamePulseTween: null,
      },
      right: {
        team: 'right',
        color: 'blue',
        hp: MAX_CASTLE_HP,
        stage: 100,
        destroyed: false,
        sprite: rightCastleSprite,
        baseX: rightCastleX,
        baseY: castleY,
        hitShakeTween: null,
        hitFlashTimer: null,
        lastHitDonor: null,
        isEndgamePhase: false,
        endgamePulseTween: null,
      },
    };

    this.spawnY = 1050;
    this.gateTargets = {
      left: { x: leftCastleX, y: this.castleBaseY - 48 },
      right: { x: rightCastleX, y: this.castleBaseY - 48 },
    };
  }

  createKnightAnimations() {
    Object.keys(TEAM_CONFIG).forEach((team) => {
      const { color } = TEAM_CONFIG[team];
      const animations = [
        { action: 'walk', frameRate: 12, repeat: -1 },
        { action: 'attack', frameRate: 14, repeat: -1 },
        { action: 'die', frameRate: 15.6, repeat: 0 },
      ];

      animations.forEach(({ action, frameRate, repeat }) => {
        const animationKey = `${action}-${color}`;
        if (this.anims.exists(animationKey)) return;

        this.anims.create({
          key: animationKey,
          frames: frameCatalog[color][action].map(({ key }) => ({ key })),
          frameRate,
          repeat,
        });
      });
    });
  }

  formatDonorNickname(donorNickname, maxLength = 14) {
    const characters = Array.from(String(donorNickname || 'anonymous'));
    return characters.length > maxLength
      ? `${characters.slice(0, maxLength).join('')}...`
      : characters.join('');
  }

  spawnKnight(
    team,
    donorNickname = null,
    { playSpawnSound = true, showDonorName = playSpawnSound } = {},
  ) {
    if (this.isRoundOver) return null;

    const teamConfig = TEAM_CONFIG[team];
    const creditedDonorNickname = donorNickname ? String(donorNickname) : null;
    const resolvedDonorNickname = donorNickname || this.createMockDonorNickname();
    const spawnX = GAME_WIDTH / 2 + (team === 'left' ? -SPAWN_OFFSET_FROM_CENTER : SPAWN_OFFSET_FROM_CENTER);
    const enemyTeam = team === 'left' ? 'right' : 'left';
    const formationSlot = this.reserveFormationSlot(enemyTeam);
    const firstWalkFrame = frameCatalog[teamConfig.color].walk[0].key;
    const animationKey = `walk-${teamConfig.color}`;
    const sprite = this.add
      .sprite(spawnX, this.spawnY, firstWalkFrame)
      .setDisplaySize(164, 164)
      .setFlipX(teamConfig.flipX)
      .play(animationKey);
    const nameText = showDonorName
      ? this.add
        .text(spawnX, this.spawnY - 92, this.formatDonorNickname(resolvedDonorNickname), {
          fontFamily: 'Arial Black, Arial, sans-serif',
          fontSize: '20px',
          color: '#ffffff',
          stroke: '#120b0e',
          strokeThickness: 5,
          shadow: { offsetX: 2, offsetY: 3, color: '#000000', blur: 2, fill: true },
        })
        .setOrigin(0.5)
        .setDepth(12)
      : null;

    const knight = {
      id: this.nextKnightId++,
      team,
      position: { x: spawnX, y: this.spawnY },
      state: 'walking',
      hp: KNIGHT_HP,
      sprite,
      nameText,
      enemyTeam,
      targetKnight: null,
      combatSlot: null,
      combatSlotIndex: null,
      nextAttackAt: 0,
      deathAnimationHandler: null,
      target: { x: formationSlot.x, y: formationSlot.y },
      reservedSlot: formationSlot,
      formationSlot: null,
      animationKey,
      firstWalkFrame,
      donorNickname: resolvedDonorNickname,
      decisiveDonorNickname: creditedDonorNickname,
    };

    this.activeKnights.push(knight);
    if (playSpawnSound) this.playTrackedSound('knight-spawn', { volume: 0.8 });
    this.registerComboSpawn(team, resolvedDonorNickname, this.time.now);
    if (this.castles[enemyTeam].destroyed) this.haltKnight(knight);
    this.updateDebugStatus();
    return knight;
  }

  createMockDonorNickname() {
    const nickname = MOCK_DONOR_NAMES[this.nextDonorNameIndex % MOCK_DONOR_NAMES.length];
    this.nextDonorNameIndex += 1;
    return nickname;
  }

  reserveFormationSlot(castleTeam) {
    const slotIndex = this.nextFormationSlot[castleTeam]++;
    const slotPattern = [
      { x: 0, y: -85 + FORMATION_SLOT_INSET },
      { x: -160, y: -103 + FORMATION_SLOT_INSET },
      { x: 160, y: -103 + FORMATION_SLOT_INSET },
      { x: -92, y: -67 + FORMATION_SLOT_INSET },
      { x: 92, y: -67 + FORMATION_SLOT_INSET },
      { x: -150, y: -141 + FORMATION_SLOT_INSET },
      { x: 150, y: -141 + FORMATION_SLOT_INSET },
      { x: -48, y: -123 + FORMATION_SLOT_INSET },
      { x: 48, y: -123 + FORMATION_SLOT_INSET },
      { x: 0, y: -159 + FORMATION_SLOT_INSET },
      { x: -128, y: -80 + FORMATION_SLOT_INSET },
      { x: 128, y: -80 + FORMATION_SLOT_INSET },
      { x: -60, y: -72 + FORMATION_SLOT_INSET },
      { x: 60, y: -72 + FORMATION_SLOT_INSET },
      { x: -120, y: -125 + FORMATION_SLOT_INSET },
      { x: 120, y: -125 + FORMATION_SLOT_INSET },
      { x: -75, y: -150 + FORMATION_SLOT_INSET },
      { x: 75, y: -150 + FORMATION_SLOT_INSET },
      { x: -25, y: -105 + FORMATION_SLOT_INSET },
      { x: 25, y: -105 + FORMATION_SLOT_INSET },
    ];
    const patternIndex = slotIndex % slotPattern.length;
    const slot = slotPattern[patternIndex];

    return {
      index: slotIndex,
      patternIndex,
      x: this.gateTargets[castleTeam].x + slot.x,
      y: this.castleBaseY + slot.y,
    };
  }

  spawnBurst() {
    const firstTeam = Phaser.Math.Between(0, 1) === 0 ? 'left' : 'right';

    for (let index = 0; index < 10; index += 1) {
      this.scheduleRoundCallback(index * 90, () => {
        const team = index % 2 === 0 ? firstTeam : firstTeam === 'left' ? 'right' : 'left';
        this.spawnKnight(team, null, { playSpawnSound: false });
      });
    }
  }

  triggerCombo(team) {
    for (let index = 0; index < COMBO_TRIGGER_COUNT; index += 1) {
      this.spawnKnight(team, null, { playSpawnSound: false });
    }
  }

  registerComboSpawn(team, donorNickname, time) {
    const combo = this.comboState[team];

    if (combo.isActive && time >= combo.endsAt) this.deactivateCombo(team);

    combo.spawnTimestamps = combo.spawnTimestamps.filter((timestamp) => time - timestamp <= COMBO_WINDOW_MS);
    combo.spawnTimestamps.push(time);
    combo.lastDonors.push(donorNickname);
    combo.lastDonors = combo.lastDonors.slice(-5);

    if (combo.isActive) {
      combo.totalSpawns += 1;
      const nextComboValue = Math.floor(combo.totalSpawns / COMBO_TRIGGER_COUNT) * COMBO_TRIGGER_COUNT;

      if (nextComboValue > combo.comboValue) {
        combo.comboValue = nextComboValue;
        this.playTrackedSound('combo-rise', { volume: 0.9 });
        this.showComboMessage(team);
      }

      this.updateDonorTicker();
      return;
    }

    if (combo.spawnTimestamps.length >= COMBO_TRIGGER_COUNT) {
      combo.isActive = true;
      combo.activatedAt = time;
      combo.endsAt = time + COMBO_DURATION_MS;
      combo.totalSpawns = combo.spawnTimestamps.length;
      combo.comboValue = Math.floor(combo.totalSpawns / COMBO_TRIGGER_COUNT) * COMBO_TRIGGER_COUNT;
      this.playTrackedSound('combo-start', { volume: 0.9 });
      this.showComboMessage(team);
      this.updateDonorTicker();
    }
  }

  showComboMessage(team) {
    const combo = this.comboState[team];
    const teamName = team === 'left' ? LEFT_TEAM : RIGHT_TEAM;
    this.showUiMessage(
      `combo-${team}`,
      `${teamName}: КОМБО x${combo.comboValue}!`,
      combo.endsAt,
    );
  }

  updateComboStates(time) {
    Object.keys(this.comboState).forEach((team) => {
      const combo = this.comboState[team];
      combo.spawnTimestamps = combo.spawnTimestamps.filter((timestamp) => time - timestamp <= COMBO_WINDOW_MS);

      if (combo.isActive && time >= combo.endsAt) this.deactivateCombo(team);
    });
  }

  deactivateCombo(team) {
    const combo = this.comboState[team];
    combo.isActive = false;
    combo.activatedAt = 0;
    combo.endsAt = 0;
    combo.totalSpawns = 0;
    combo.comboValue = 0;
    combo.spawnTimestamps = [];
    this.removeUiMessage(`combo-${team}`);
    this.updateDonorTicker();
  }

  getKnightMovementMultiplier(team) {
    return this.comboState[team].isActive ? COMBO_SPEED_MULTIPLIER : 1;
  }

  update(time, delta) {
    this.flushGiftSpawnQueue();
    if (this.isRoundOver) {
      this.updateUiMessageSlot(time);
      return;
    }

    this.updateEndgameStates(time);
    this.updateComboStates(time);
    this.updateUiMessageSlot(time);
    const baseMovementStep = KNIGHT_SPEED * (delta / 1000);

    this.activeKnights.forEach((knight) => {
      const movementStep = baseMovementStep * this.getKnightMovementMultiplier(knight.team);

      if (knight.state === 'fighting') {
        this.updateFightingKnight(knight, time, movementStep);
        return;
      }

      if (knight.state === 'attacking_castle') {
        this.updateCastleAttacker(knight, time);
        return;
      }

      if (knight.state !== 'walking' && knight.state !== 'arrived') return;

      // Every living knight keeps scanning, including knights already stationed at a castle.
      const nearbyEnemy = this.findNearestEnemy(knight);
      if (nearbyEnemy) {
        this.startFighting(knight, nearbyEnemy, time);
        return;
      }

      if (knight.state === 'arrived') return;

      const dx = knight.target.x - knight.position.x;
      const dy = knight.target.y - knight.position.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= movementStep) {
        knight.position.x = knight.target.x;
        knight.position.y = knight.target.y;
        knight.sprite.setPosition(knight.position.x, knight.position.y);
        this.markKnightArrived(knight, time);
        return;
      }

      knight.position.x += (dx / distance) * movementStep;
      knight.position.y += (dy / distance) * movementStep;
      knight.sprite.setPosition(knight.position.x, knight.position.y);
    });
    this.activeKnights.forEach((knight) => this.syncKnightNameLabel(knight));
  }

  syncKnightNameLabel(knight) {
    if (!knight.nameText?.visible) return;
    knight.nameText.setPosition(knight.sprite.x, knight.sprite.y - 92);
  }

  findNearestEnemy(knight) {
    let nearestEnemy = null;
    let nearestDistanceSquared = COMBAT_RADIUS * COMBAT_RADIUS;

    this.activeKnights.forEach((candidate) => {
      if (candidate.team === knight.team || candidate.state === 'dying' || candidate.hp <= 0) return;

      const dx = candidate.position.x - knight.position.x;
      const dy = candidate.position.y - knight.position.y;
      const distanceSquared = dx * dx + dy * dy;

      if (distanceSquared <= nearestDistanceSquared) {
        nearestEnemy = candidate;
        nearestDistanceSquared = distanceSquared;
      }
    });

    return nearestEnemy;
  }

  isTargetInRange(knight, target) {
    if (!target || target.state === 'dying' || target.hp <= 0) return false;

    const dx = target.position.x - knight.position.x;
    const dy = target.position.y - knight.position.y;
    return dx * dx + dy * dy <= COMBAT_RADIUS * COMBAT_RADIUS;
  }

  startFighting(knight, target, time) {
    if (knight.state === 'dying' || knight.state === 'halted' || !target) return;

    knight.state = 'fighting';
    knight.targetKnight = target;
    knight.combatSlot = knight.formationSlot
      ? { x: knight.formationSlot.x, y: knight.formationSlot.y }
      : this.reserveCombatSlot(knight, target);
    knight.nextAttackAt = time + 1000;
    knight.sprite.play(`attack-${TEAM_CONFIG[knight.team].color}`, true);
    this.faceKnightTowardTarget(knight, target);
    this.updateDebugStatus();
  }

  reserveCombatSlot(knight, target) {
    const usedSlotIndexes = new Set(
      this.activeKnights
        .filter((candidate) => candidate !== knight && candidate.state === 'fighting' && candidate.targetKnight === target)
        .map((candidate) => candidate.combatSlotIndex)
        .filter((slotIndex) => slotIndex !== null),
    );
    let slotIndex = Array.from({ length: COMBAT_SLOT_COUNT }, (_, index) => index).find(
      (index) => !usedSlotIndexes.has(index),
    );

    if (slotIndex === undefined) slotIndex = knight.id % COMBAT_SLOT_COUNT;
    knight.combatSlotIndex = slotIndex;

    const step = Math.PI / 8;
    const orderedOffsets = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, 8];
    const approachAngle = knight.team === 'left' ? Math.PI : 0;
    const angle = approachAngle + orderedOffsets[slotIndex] * step;

    return {
      x: target.position.x + Math.cos(angle) * COMBAT_SLOT_RADIUS,
      y: target.position.y + Math.sin(angle) * COMBAT_SLOT_RADIUS,
    };
  }

  updateFightingKnight(knight, time, movementStep) {
    const target = knight.targetKnight;

    if (!this.isTargetInRange(knight, target)) {
      this.chooseNextAction(knight, time);
      return;
    }

    this.moveKnightTowardCombatSlot(knight, movementStep);
    this.faceKnightTowardTarget(knight, target);

    if (time >= knight.nextAttackAt) {
      knight.nextAttackAt = time + 1000;
      this.dealDamage(knight, target, time);
    }
  }

  moveKnightTowardCombatSlot(knight, movementStep) {
    if (!knight.combatSlot) return;

    const dx = knight.combatSlot.x - knight.position.x;
    const dy = knight.combatSlot.y - knight.position.y;
    const distance = Math.hypot(dx, dy);

    if (distance <= movementStep) {
      knight.position.x = knight.combatSlot.x;
      knight.position.y = knight.combatSlot.y;
    } else if (distance > 0) {
      knight.position.x += (dx / distance) * movementStep;
      knight.position.y += (dy / distance) * movementStep;
    }

    knight.sprite.setPosition(knight.position.x, knight.position.y);
  }

  faceKnightTowardTarget(knight, target) {
    if (target.position.x < knight.position.x) {
      knight.sprite.setFlipX(true);
    } else if (target.position.x > knight.position.x) {
      knight.sprite.setFlipX(false);
    }
  }

  dealDamage(attacker, target, time) {
    if (this.isRoundOver || !this.isTargetInRange(attacker, target)) return;

    this.playRandomVariant('swordHit', { volume: 0.72 });
    target.hp = Math.max(0, target.hp - this.getTeamDamage(attacker.team, KNIGHT_DAMAGE));
    if (target.hp === 0) {
      this.killKnight(target, time);
    }
  }

  killKnight(knight, time) {
    if (knight.state === 'dying') return;

    knight.state = 'dying';
    knight.hp = 0;
    knight.targetKnight = null;
    knight.combatSlot = null;
    knight.combatSlotIndex = null;
    knight.nameText?.setVisible(false);
    this.playRandomVariant('knightDeath', { volume: 0.82 });
    const dieAnimationKey = `die-${TEAM_CONFIG[knight.team].color}`;
    knight.sprite.play(dieAnimationKey, true);
    knight.deathAnimationHandler = () => {
      this.pendingDeathKnights.delete(knight);
      knight.deathAnimationHandler = null;
      if (!this.isRoundOver) this.removeKnight(knight);
    };
    this.pendingDeathKnights.add(knight);
    knight.sprite.once('animationcomplete', knight.deathAnimationHandler);

    this.activeKnights.forEach((candidate) => {
      if (candidate.state === 'fighting' && candidate.targetKnight === knight) {
        candidate.targetKnight = null;
        this.chooseNextAction(candidate, time);
      }
    });

    this.updateDebugStatus();
  }

  chooseNextAction(knight, time) {
    if (knight.state === 'dying' || knight.state === 'halted') return;

    knight.targetKnight = null;
    const nearbyEnemy = this.findNearestEnemy(knight);

    if (nearbyEnemy) {
      this.startFighting(knight, nearbyEnemy, time);
      return;
    }

    if (knight.formationSlot) {
      this.startAttackingCastle(knight, time);
      return;
    }

    this.resumeWalking(knight);
  }

  resumeWalking(knight) {
    if (this.castles[knight.enemyTeam].destroyed) {
      this.haltKnight(knight);
      return;
    }

    knight.state = 'walking';
    knight.targetKnight = null;
    knight.combatSlot = null;
    knight.combatSlotIndex = null;
    knight.sprite.setFlipX(TEAM_CONFIG[knight.team].flipX);
    knight.sprite.play(knight.animationKey, true);
    this.updateDebugStatus();
  }

  removeKnight(knight) {
    if (knight.deathAnimationHandler) {
      knight.sprite.off('animationcomplete', knight.deathAnimationHandler);
      knight.deathAnimationHandler = null;
    }
    this.pendingDeathKnights.delete(knight);
    const index = this.activeKnights.indexOf(knight);
    if (index !== -1) this.activeKnights.splice(index, 1);
    if (knight.nameText?.active) knight.nameText.destroy();
    if (knight.sprite.active) knight.sprite.destroy();
    this.updateDebugStatus();
  }

  markKnightArrived(knight, time) {
    knight.formationSlot = knight.reservedSlot;
    this.startAttackingCastle(knight, time);
  }

  startAttackingCastle(knight, time) {
    const castle = this.castles[knight.enemyTeam];

    if (castle.destroyed) {
      this.haltKnight(knight);
      return;
    }

    knight.state = 'attacking_castle';
    knight.targetKnight = null;
    knight.combatSlot = null;
    knight.combatSlotIndex = null;
    knight.nextAttackAt = time + 1000;
    this.orientKnightTowardGate(knight);
    knight.sprite.play(`attack-${TEAM_CONFIG[knight.team].color}`, true);
    this.updateDebugStatus();
  }

  updateCastleAttacker(knight, time) {
    const nearbyEnemy = this.findNearestEnemy(knight);
    if (nearbyEnemy) {
      this.startFighting(knight, nearbyEnemy, time);
      return;
    }

    const castle = this.castles[knight.enemyTeam];
    if (castle.destroyed) {
      this.haltKnight(knight);
      return;
    }

    if (time >= knight.nextAttackAt) {
      knight.nextAttackAt = time + 1000;
      this.damageCastle(knight.enemyTeam, this.getTeamDamage(knight.team, CASTLE_DAMAGE), knight);
    }
  }

  haltKnight(knight) {
    if (knight.state === 'dying') return;

    knight.state = 'halted';
    knight.targetKnight = null;
    knight.combatSlot = null;
    knight.combatSlotIndex = null;
    knight.sprite.stop();
    knight.sprite.setTexture(knight.firstWalkFrame);
    this.updateDebugStatus();
  }

  updateEndgameStates(time) {
    Object.values(this.castles).forEach((castle) => {
      const isEndgamePhase = castle.hp < MAX_CASTLE_HP * ENDGAME_HP_THRESHOLD_PERCENT;

      if (castle.isEndgamePhase !== isEndgamePhase) {
        castle.isEndgamePhase = isEndgamePhase;
        this.setEndgameVisuals(castle, isEndgamePhase);
        this.updateEndgameDebugIndicator();
      }
    });

    const hasActiveEndgame = Object.values(this.castles).some((castle) => castle.isEndgamePhase);
    if (hasActiveEndgame && time >= this.nextEndgameShakeAt) {
      this.cameras.main.shake(170, 0.0025);
      this.nextEndgameShakeAt = time + Phaser.Math.Between(1400, 2300);
    } else if (!hasActiveEndgame) {
      this.nextEndgameShakeAt = 0;
    }
  }

  setEndgameVisuals(castle, isActive) {
    const hpUi = this.castleHpUi?.[castle.team];
    if (!hpUi) return;

    if (castle.endgamePulseTween) {
      castle.endgamePulseTween.stop();
      castle.endgamePulseTween = null;
    }

    hpUi.fillGraphics.setAlpha(1);
    hpUi.hpText.setAlpha(1);

    if (!isActive) return;

    this.playTrackedSound('endgame-alarm', { volume: 0.9 });
    castle.endgamePulseTween = this.tweens.add({
      targets: [hpUi.fillGraphics, hpUi.hpText],
      alpha: 0.32,
      duration: 620,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });
    this.showEndgameMessage(castle.team, 'Қамал жойылуға жақын!');
  }

  showEndgameMessage(team, message) {
    this.showUiMessage(`endgame-${team}`, message, this.time.now + 2600);
  }

  showUiMessage(key, text, expiresAt) {
    if (!this.uiMessages) return;

    this.uiMessageSequence += 1;
    this.uiMessages.set(key, {
      key,
      text,
      expiresAt,
      sequence: this.uiMessageSequence,
    });
  }

  removeUiMessage(key) {
    if (!this.uiMessages) return;
    this.uiMessages.delete(key);
    if (this.activeUiMessageKey === key) this.activeUiMessageKey = null;
    this.updateUiMessageSlot(this.time.now);
  }

  updateUiMessageSlot(time) {
    if (!this.uiMessages || !this.uiMessageText) return;

    this.uiMessages.forEach((entry, key) => {
      if (time >= entry.expiresAt) this.uiMessages.delete(key);
    });

    const newestMessage = [...this.uiMessages.values()].sort((a, b) => b.sequence - a.sequence)[0];
    if (!newestMessage) {
      this.activeUiMessageKey = null;
      this.uiMessageText.setVisible(false);
      return;
    }

    if (this.activeUiMessageKey !== newestMessage.key || this.uiMessageText.text !== newestMessage.text) {
      this.activeUiMessageKey = newestMessage.key;
      this.uiMessageText.setText(newestMessage.text).setVisible(true).setAlpha(1);
    }
  }

  updateDonorTicker() {
    if (!this.donorTickerText) return;

    const activeTeams = Object.keys(this.comboState).filter((team) => this.comboState[team].isActive);
    if (activeTeams.length === 0) {
      this.donorTickerText.setVisible(false);
      return;
    }

    const tickerLines = activeTeams.map((team) => {
      const teamName = team === 'left' ? LEFT_TEAM : RIGHT_TEAM;
      const donors = this.comboState[team].lastDonors.join('  •  ');
      return `${teamName}: ${donors}`;
    });

    this.donorTickerText.setText(tickerLines.join('\n')).setVisible(true);
  }

  getTeamDamage(team, baseDamage) {
    return baseDamage * (this.castles[team].isEndgamePhase ? COMEBACK_DAMAGE_MULTIPLIER : 1);
  }

  damageCastle(castleTeam, amount, attacker = null) {
    const castle = this.castles[castleTeam];
    if (this.isRoundOver || !castle || castle.destroyed) return;

    this.playRandomVariant('castleHit', { volume: 0.78 });
    castle.hp = Math.max(0, castle.hp - amount);
    this.playCastleHitFeedback(castle);
    const nextStage = this.getCastleStage(castle.hp);

    if (nextStage !== castle.stage) {
      castle.stage = nextStage;
      castle.sprite.setTexture(`castle-${castle.color}-${nextStage}`);
      if (nextStage > 0) this.playCastleStageSoundSequence(castleTeam);
    }

    this.updateCastleHpBar(castleTeam);

    if (castle.hp === 0) {
      castle.destroyed = true;
      castle.lastHitDonor = attacker?.decisiveDonorNickname || null;
      this.castleSoundSequence[castleTeam] += 1;
      this.playCastleExplosion(castle);
      this.haltAttackersForDestroyedCastle(castleTeam);
      const winnerTeam = castleTeam === 'left' ? 'right' : 'left';
      this.handleVictory(winnerTeam, castle.lastHitDonor);
    }
  }

  handleVictory(winnerTeam, decisiveDonor = null) {
    if (this.isRoundOver) return;

    this.isRoundOver = true;
    this.giftSpawnQueue?.clear();
    this.playTrackedSound('victory', { volume: 1 });
    if (winnerTeam === 'left') {
      this.leftScore += 1;
    } else {
      this.rightScore += 1;
    }
    this.updateScoreText();
    this.freezeAllKnights();

    Object.keys(this.comboState).forEach((team) => this.deactivateCombo(team));
    this.uiMessages.clear();
    const winnerMessage = winnerTeam === 'left' ? 'Алматы жеңді!' : 'Шымкент жеңді!';
    this.victoryDimOverlay.setVisible(true).setAlpha(0.5);
    this.uiMessageText
      .setPosition(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 90)
      .setFontSize(86)
      .setBackgroundColor(null)
      .setPadding(0)
      .setDepth(70);
    this.showUiMessage('victory', winnerMessage, Number.POSITIVE_INFINITY);
    this.updateUiMessageSlot(this.time.now);
    if (decisiveDonor) {
      this.decisiveHitText
        .setText(`Шешуші соққы берген:\n${this.formatDonorNickname(decisiveDonor, 22)}`)
        .setVisible(true);
    } else {
      this.decisiveHitText.setVisible(false);
    }

    this.startVictoryFireworks(winnerTeam);
    this.startRoundCountdown();
  }

  updateScoreText() {
    if (!this.scoreTexts) return;
    this.scoreTexts.left.setText(String(this.leftScore));
    this.scoreTexts.right.setText(String(this.rightScore));
  }

  freezeAllKnights() {
    this.activeKnights.forEach((knight) => {
      knight.state = 'round_over';
      knight.targetKnight = null;
      knight.combatSlot = null;
      knight.combatSlotIndex = null;
      knight.nextAttackAt = Number.POSITIVE_INFINITY;
      knight.sprite.anims.pause();
    });
    this.updateDebugStatus();
  }

  startRoundCountdown() {
    let secondsRemaining = RESTART_DELAY_SECONDS;
    this.roundCountdownText
      .setText(`ЖАҢА РАУНД\n${secondsRemaining}`)
      .setVisible(true);

    this.roundCountdownEvent = this.trackRoundTimer(this.time.addEvent({
      delay: 1000,
      repeat: RESTART_DELAY_SECONDS - 1,
      callback: () => {
        secondsRemaining -= 1;
        this.roundCountdownText.setText(`ЖАҢА РАУНД\n${secondsRemaining}`);

        if (secondsRemaining === 0) {
          this.roundResetTimer = this.scheduleRoundCallback(300, () => this.resetRound());
        }
      },
    }));
  }

  startVictoryFireworks(winnerTeam) {
    const teamColor = winnerTeam === 'left' ? 0xff334d : 0x3395ff;

    for (let index = 0; index < 30; index += 1) {
      this.scheduleRoundCallback(index * 330, () => this.launchFireworkBurst(teamColor));
    }
  }

  launchFireworkBurst(teamColor) {
    if (!this.isRoundOver) return;

    const originX = Phaser.Math.Between(60, GAME_WIDTH - 60);
    const originY = Phaser.Math.Between(100, GAME_HEIGHT - 100);
    const colors = [teamColor, 0xffd43b, 0xffffff, 0xff7a24, 0xa75cff];

    for (let index = 0; index < 44; index += 1) {
      const angle = (Math.PI * 2 * index) / 44 + Phaser.Math.FloatBetween(-0.08, 0.08);
      const distance = Phaser.Math.Between(150, 340);
      const particle = this.trackRoundEffect(
        this.add
          .circle(originX, originY, Phaser.Math.Between(6, 13), Phaser.Utils.Array.GetRandom(colors), 1)
          .setDepth(60),
      );
      let tween = null;
      tween = this.trackRoundEffectTween(this.tweens.add({
        targets: particle,
        x: originX + Math.cos(angle) * distance,
        y: originY + Math.sin(angle) * distance + Phaser.Math.Between(10, 70),
        alpha: 0,
        scale: 0.25,
        duration: Phaser.Math.Between(850, 1450),
        ease: 'Cubic.easeOut',
        onComplete: () => {
          this.roundEffectTweens.delete(tween);
          this.roundEffectObjects.delete(particle);
          particle.destroy();
        },
      }));
    }
  }

  resetRound() {
    this.clearRoundAsyncWork();
    this.castleSoundSequence.left += 1;
    this.castleSoundSequence.right += 1;
    this.roundCountdownEvent = null;
    this.roundResetTimer = null;

    this.activeKnights.forEach((knight) => {
      if (knight.nameText?.active) knight.nameText.destroy();
      if (knight.sprite.active) knight.sprite.destroy();
    });
    this.activeKnights = [];
    this.nextFormationSlot = { left: 0, right: 0 };

    Object.values(this.castles).forEach((castle) => {
      if (castle.hitShakeTween) castle.hitShakeTween.stop();
      if (castle.endgamePulseTween) castle.endgamePulseTween.stop();
      castle.hitShakeTween = null;
      castle.hitFlashTimer = null;
      castle.endgamePulseTween = null;
      castle.hp = MAX_CASTLE_HP;
      castle.stage = 100;
      castle.destroyed = false;
      castle.lastHitDonor = null;
      castle.isEndgamePhase = false;
      castle.sprite
        .setTexture(`castle-${castle.color}-100`)
        .setPosition(castle.baseX, castle.baseY)
        .clearTint()
        .setAlpha(1);
      this.updateCastleHpBar(castle.team);
      const hpUi = this.castleHpUi[castle.team];
      hpUi.fillGraphics.setAlpha(1);
      hpUi.hpText.setAlpha(1);
    });

    Object.keys(this.comboState).forEach((team) => {
      this.deactivateCombo(team);
      this.comboState[team].lastDonors = [];
    });

    this.uiMessages.clear();
    this.activeUiMessageKey = null;
    this.victoryDimOverlay.setVisible(false);
    this.uiMessageText
      .setPosition(GAME_WIDTH / 2, 350)
      .setFontSize(30)
      .setBackgroundColor('rgba(49, 4, 8, 0.88)')
      .setPadding(22, 10)
      .setDepth(0)
      .setVisible(false);
    this.roundCountdownText.setVisible(false);
    this.decisiveHitText.setVisible(false);
    this.donorTickerText.setVisible(false);
    this.nextEndgameShakeAt = 0;
    this.cameras.main.resetFX();
    this.isRoundOver = false;
    this.updateEndgameDebugIndicator();
    this.updateDebugStatus();
  }

  playCastleHitFeedback(castle) {
    this.emitCastleSplinters(castle);

    if (castle.hitShakeTween) castle.hitShakeTween.stop();
    castle.sprite.setPosition(castle.baseX, castle.baseY);
    castle.hitShakeTween = this.tweens.addCounter({
      from: 0,
      to: Math.PI * 6,
      duration: 220,
      ease: 'Quad.easeOut',
      onUpdate: (tween) => {
        const strength = 1 - tween.progress;
        castle.sprite.setPosition(
          castle.baseX + Math.sin(tween.getValue()) * 6 * strength,
          castle.baseY + Math.cos(tween.getValue() * 1.7) * 2 * strength,
        );
      },
      onComplete: () => {
        castle.sprite.setPosition(castle.baseX, castle.baseY);
        castle.hitShakeTween = null;
      },
    });

    if (castle.hitFlashTimer) this.cancelRoundTimer(castle.hitFlashTimer);
    castle.sprite.setTint(0xff3b32).setAlpha(0.72);
    castle.hitFlashTimer = this.scheduleRoundCallback(105, () => {
      castle.sprite.clearTint().setAlpha(1);
      castle.hitFlashTimer = null;
    });
  }

  emitCastleSplinters(castle) {
    const originX = castle.baseX;
    const originY = castle.baseY + 105;
    const splinterColors = [0x6f3d20, 0x8f5629, 0xb17a3c, 0xd1a05c, 0x4b3021];

    for (let index = 0; index < 30; index += 1) {
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const distance = Phaser.Math.Between(45, 125);
      const splinter = this.trackRoundEffect(
        this.add.rectangle(
          originX + Phaser.Math.Between(-30, 30),
          originY + Phaser.Math.Between(-35, 25),
          Phaser.Math.Between(3, 7),
          Phaser.Math.Between(8, 17),
          Phaser.Utils.Array.GetRandom(splinterColors),
          0.95,
        )
          .setAngle(Phaser.Math.Between(0, 180))
          .setDepth(castle.sprite.depth + 1),
      );

      let tween = null;
      tween = this.trackRoundEffectTween(this.tweens.add({
        targets: splinter,
        x: splinter.x + Math.cos(angle) * distance,
        y: splinter.y + Math.sin(angle) * distance + Phaser.Math.Between(-30, 35),
        angle: splinter.angle + Phaser.Math.Between(-240, 240),
        alpha: 0,
        scale: Phaser.Math.FloatBetween(0.45, 1.15),
        duration: Phaser.Math.Between(320, 560),
        ease: 'Quad.easeOut',
        onComplete: () => {
          this.roundEffectTweens.delete(tween);
          this.roundEffectObjects.delete(splinter);
          splinter.destroy();
        },
      }));
    }
  }

  getCastleStage(hp) {
    const hpRatio = hp / MAX_CASTLE_HP;

    if (hpRatio > 0.7) return 100;
    if (hpRatio > 0.5) return 70;
    if (hpRatio > 0.3) return 50;
    if (hpRatio > 0) return 30;
    return 0;
  }

  haltAttackersForDestroyedCastle(castleTeam) {
    this.activeKnights.forEach((knight) => {
      if (knight.enemyTeam === castleTeam && knight.state !== 'dying') {
        this.haltKnight(knight);
      }
    });
  }

  playCastleExplosion(castle) {
    this.playTrackedSound('castle-explode', { volume: 1 });
    const centerX = castle.sprite.x;
    const centerY = castle.sprite.y + 80;
    const particleColors = [0xffd447, 0xff8a24, 0xe83b24, 0x5c2b1c, 0x3a3330];

    for (let index = 0; index < 84; index += 1) {
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const distance = Phaser.Math.Between(210, 660);
      const particle = this.trackRoundEffect(
        this.add.circle(
          centerX + Phaser.Math.Between(-35, 35),
          centerY + Phaser.Math.Between(-45, 45),
          Phaser.Math.Between(10, 24),
          Phaser.Utils.Array.GetRandom(particleColors),
          0.95,
        ),
      );

      let tween = null;
      tween = this.trackRoundEffectTween(this.tweens.add({
        targets: particle,
        x: particle.x + Math.cos(angle) * distance,
        y: particle.y + Math.sin(angle) * distance - Phaser.Math.Between(20, 100),
        scale: Phaser.Math.FloatBetween(0.3, 1.8),
        alpha: 0,
        duration: Phaser.Math.Between(650, 1250),
        ease: 'Quad.easeOut',
        onComplete: () => {
          this.roundEffectTweens.delete(tween);
          this.roundEffectObjects.delete(particle);
          particle.destroy();
        },
      }));
    }

    this.cameras.main.shake(620, 0.011);
  }

  orientKnightTowardGate(knight) {
    const gateCenterX = this.gateTargets[knight.enemyTeam].x;
    const slotOffsetX = knight.formationSlot.x - gateCenterX;

    if (slotOffsetX < 0) {
      knight.sprite.setFlipX(false);
    } else if (slotOffsetX > 0) {
      knight.sprite.setFlipX(true);
    }
  }

  createTopUi() {
    const graphics = this.add.graphics();
    this.castleHpUi = {};

    graphics.fillStyle(0x08070d, 0.9).fillRoundedRect(22, 18, 1036, 205, 24);
    graphics.lineStyle(6, UI.goldDark, 1).strokeRoundedRect(22, 18, 1036, 205, 24);
    graphics.lineStyle(2, UI.gold, 0.85).strokeRoundedRect(31, 27, 1018, 187, 18);

    this.drawTeamBanner(graphics, 'left');
    this.drawTeamBanner(graphics, 'right');

    this.add
      .text(GAME_WIDTH / 2, 83, 'VS', {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '76px',
        fontStyle: 'italic',
        color: '#ffcf37',
        stroke: '#2b1010',
        strokeThickness: 12,
        shadow: { offsetX: 4, offsetY: 5, color: '#000000', blur: 1, fill: true },
      })
      .setOrigin(0.5);

    this.add.text(248, 72, LEFT_TEAM, this.teamTitleStyle()).setOrigin(0.5);
    this.add.text(832, 72, RIGHT_TEAM, this.teamTitleStyle()).setOrigin(0.5);

    this.drawTrophy(graphics, 206, 176);
    this.drawTrophy(graphics, 790, 176);
    this.scoreTexts = {
      left: this.add.text(245, 179, '0', this.scoreStyle()).setOrigin(0.5),
      right: this.add.text(829, 179, '0', this.scoreStyle()).setOrigin(0.5),
    };

    this.drawHpBar(graphics, 58, 251, 445, 'left');
    this.drawHpBar(graphics, 577, 251, 445, 'right');

    this.victoryDimOverlay = this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH + 160, GAME_HEIGHT + 160, 0x000000, 0.5)
      .setDepth(50)
      .setVisible(false);

    this.uiMessages = new Map();
    this.uiMessageSequence = 0;
    this.activeUiMessageKey = null;
    this.uiMessageText = this.add
      .text(GAME_WIDTH / 2, 350, '', {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '30px',
        color: '#fff0b5',
        stroke: '#6e0909',
        strokeThickness: 7,
        backgroundColor: 'rgba(49, 4, 8, 0.88)',
        padding: { x: 22, y: 10 },
      })
      .setOrigin(0.5)
      .setVisible(false);

    this.decisiveHitText = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 55, '', {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '64px',
        color: '#ffd66b',
        stroke: '#160b0d',
        strokeThickness: 10,
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(70)
      .setVisible(false);

    this.roundCountdownText = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 215, '', {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '48px',
        color: '#ffffff',
        stroke: '#160b0d',
        strokeThickness: 9,
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(70)
      .setVisible(false);

    this.donorTickerText = this.add
      .text(GAME_WIDTH / 2, 1145, '', {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '18px',
        color: '#fff2b0',
        stroke: '#160b0d',
        strokeThickness: 5,
        align: 'center',
        backgroundColor: 'rgba(20, 8, 14, 0.9)',
        padding: { x: 22, y: 10 },
      })
      .setOrigin(0.5)
      .setVisible(false);
  }

  drawTeamBanner(graphics, side) {
    const isLeft = side === 'left';
    const startX = isLeft ? 44 : 618;
    const bannerColor = isLeft ? UI.red : UI.blue;
    const darkColor = isLeft ? UI.redDark : UI.blueDark;
    const points = isLeft
      ? [new Phaser.Geom.Point(startX, 42), new Phaser.Geom.Point(458, 42), new Phaser.Geom.Point(430, 91), new Phaser.Geom.Point(458, 132), new Phaser.Geom.Point(startX, 132)]
      : [new Phaser.Geom.Point(622, 42), new Phaser.Geom.Point(1036, 42), new Phaser.Geom.Point(1036, 132), new Phaser.Geom.Point(622, 132), new Phaser.Geom.Point(650, 91)];

    graphics.fillStyle(darkColor, 1).fillPoints(points, true);
    graphics.lineStyle(6, UI.ink, 1).strokePoints(points, true);
    graphics.lineStyle(2, bannerColor, 1).strokePoints(points, true);

    const shieldX = isLeft ? 72 : 1008;
    graphics.fillStyle(bannerColor, 1).fillRoundedRect(shieldX - 38, 31, 76, 118, 9);
    graphics.lineStyle(5, UI.gold, 1).strokeRoundedRect(shieldX - 38, 31, 76, 118, 9);
    graphics.fillStyle(UI.gold, 1).fillCircle(shieldX, 67, 13);
    graphics.fillTriangle(shieldX - 21, 98, shieldX + 21, 98, shieldX, 132);
  }

  drawTrophy(graphics, x, y) {
    graphics.fillStyle(UI.gold, 1);
    graphics.fillRoundedRect(x - 12, y - 14, 24, 22, 5);
    graphics.fillRect(x - 4, y + 6, 8, 12);
    graphics.fillRoundedRect(x - 13, y + 17, 26, 6, 3);
    graphics.lineStyle(5, UI.gold, 1);
    graphics.beginPath();
    graphics.arc(x - 12, y - 3, 11, Phaser.Math.DegToRad(90), Phaser.Math.DegToRad(270), false);
    graphics.strokePath();
    graphics.beginPath();
    graphics.arc(x + 12, y - 3, 11, Phaser.Math.DegToRad(270), Phaser.Math.DegToRad(90), false);
    graphics.strokePath();
  }

  drawHpBar(graphics, x, y, width, side) {
    const capX = side === 'left' ? x : x + width;
    const backgroundGraphics = this.add.graphics();
    const fillGraphics = this.add.graphics();
    const frameGraphics = this.add.graphics();

    backgroundGraphics.fillStyle(UI.ink, 0.96).fillRoundedRect(x, y, width, 58, 14);
    frameGraphics.lineStyle(6, UI.goldDark, 1).strokeRoundedRect(x, y, width, 58, 14);
    frameGraphics.fillStyle(UI.parchment, 1).fillRoundedRect(capX - 29, y + 11, 58, 36, 7);
    frameGraphics.lineStyle(4, UI.ink, 1).strokeRoundedRect(capX - 29, y + 11, 58, 36, 7);
    frameGraphics.fillStyle(side === 'left' ? UI.red : UI.blue, 1).fillRect(capX - 7, y + 20, 14, 18);

    const hpText = this.add
      .text(x + width / 2, y + 29, '', {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '24px',
        color: '#ffffff',
        stroke: '#123819',
        strokeThickness: 5,
      })
      .setOrigin(0.5);

    this.castleHpUi[side] = { fillGraphics, hpText, x, y, width };
    this.updateCastleHpBar(side);
  }

  updateCastleHpBar(side) {
    const ui = this.castleHpUi?.[side];
    const castle = this.castles?.[side];
    if (!ui || !castle) return;

    const hpRatio = Phaser.Math.Clamp(castle.hp / MAX_CASTLE_HP, 0, 1);
    const fillWidth = (ui.width - 20) * hpRatio;
    ui.fillGraphics.clear();

    if (fillWidth > 0) {
      ui.fillGraphics.fillStyle(UI.hp, 1).fillRoundedRect(ui.x + 10, ui.y + 10, fillWidth, 38, 8);
      if (fillWidth > 8) {
        ui.fillGraphics
          .fillStyle(0xffffff, 0.18)
          .fillRoundedRect(ui.x + 12, ui.y + 12, Math.max(4, fillWidth - 4), 12, 5);
      }
    }

    ui.hpText.setText(`${castle.hp} / ${MAX_CASTLE_HP}`);
  }

  createDebugPanel() {
    this.debugPanel = this.add.container(0, 0).setDepth(90).setVisible(false);

    this.createDebugButton(285, 1085, 500, '[TRIGGER COMBO LEFT]', UI.redDark, () =>
      this.triggerCombo('left'),
    );
    this.createDebugButton(795, 1085, 500, '[TRIGGER COMBO RIGHT]', UI.blueDark, () =>
      this.triggerCombo('right'),
    );
    this.createDebugButton(285, 1252, 500, '[DAMAGE LEFT CASTLE]', UI.redDark, () =>
      this.damageCastle('left', 300),
    );
    this.createDebugButton(795, 1252, 500, '[DAMAGE RIGHT CASTLE]', UI.blueDark, () =>
      this.damageCastle('right', 300),
    );
    this.createDebugButton(200, 1336, 300, '[SPAWN LEFT]', UI.redDark, () =>
      this.spawnKnight('left', null, { playSpawnSound: true, showDonorName: false }),
    );
    this.createDebugButton(540, 1336, 300, '[SPAWN BURST 10]', UI.goldDark, () => this.spawnBurst());
    this.createDebugButton(880, 1336, 300, '[SPAWN RIGHT]', UI.blueDark, () =>
      this.spawnKnight('right', null, { playSpawnSound: true, showDonorName: false }),
    );

    const counts = [
      `R ${frameCatalog.red.walk.length}/${frameCatalog.red.attack.length}/${frameCatalog.red.die.length}`,
      `B ${frameCatalog.blue.walk.length}/${frameCatalog.blue.attack.length}/${frameCatalog.blue.die.length}`,
    ].join('  |  ');

    this.endgameDebugText = this.add
      .text(GAME_WIDTH / 2, 1195, '', {
        fontFamily: 'Consolas, monospace',
        fontSize: '21px',
        color: '#ffd76a',
        backgroundColor: 'rgba(10, 8, 12, 0.82)',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5);
    this.debugPanel.add(this.endgameDebugText);
    this.updateEndgameDebugIndicator();

    this.debugStatusText = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 30, `DEBUG | STEP 7 | TOTAL 0 | WALKING 0 | FIGHTING 0 | ARRIVED 0 | ${counts}`, {
        fontFamily: 'Consolas, monospace',
        fontSize: '18px',
        color: '#f8e7b0',
        backgroundColor: 'rgba(10, 8, 12, 0.78)',
        padding: { x: 14, y: 8 },
      })
      .setOrigin(0.5);
    this.debugPanel.add(this.debugStatusText);
  }

  createKeyboardControls() {
    if (!this.input.keyboard) return;

    const toggleKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.BACKTICK);
    const leftSpawnKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Q);
    const rightSpawnKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);

    toggleKey.on('down', (key, event) => {
      if (!event?.repeat) this.debugPanel.setVisible(!this.debugPanel.visible);
    });
    leftSpawnKey.on('down', (key, event) => {
      if (!event?.repeat) {
        this.spawnKnight('left', null, { playSpawnSound: true, showDonorName: false });
      }
    });
    rightSpawnKey.on('down', (key, event) => {
      if (!event?.repeat) {
        this.spawnKnight('right', null, { playSpawnSound: true, showDonorName: false });
      }
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      toggleKey.destroy();
      leftSpawnKey.destroy();
      rightSpawnKey.destroy();
    });
  }

  createDebugButton(x, y, width, label, color, onClick) {
    const button = this.add
      .rectangle(x, y, width, 64, color, 0.96)
      .setStrokeStyle(4, UI.gold, 1)
      .setInteractive({ useHandCursor: true });
    const text = this.add
      .text(x, y, label, {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '22px',
        color: '#fff4cf',
        stroke: '#140d12',
        strokeThickness: 5,
      })
      .setOrigin(0.5);

    button.on('pointerover', () => button.setFillStyle(color, 1));
    button.on('pointerout', () => button.setFillStyle(color, 0.96));
    button.on('pointerdown', () => {
      button.setScale(0.97);
      onClick();
    });
    button.on('pointerup', () => button.setScale(1));
    button.on('pointerout', () => button.setScale(1));

    this.debugPanel.add([button, text]);

    return { button, text };
  }

  updateDebugStatus() {
    if (!this.debugStatusText) return;

    const walking = this.activeKnights.filter(({ state }) => state === 'walking').length;
    const fighting = this.activeKnights.filter(({ state }) => state === 'fighting').length;
    const arrived = this.activeKnights.filter(({ state }) => state === 'attacking_castle').length;
    this.debugStatusText.setText(
      `DEBUG | STEP 7 | TOTAL ${this.activeKnights.length} | WALKING ${walking} | FIGHTING ${fighting} | ARRIVED ${arrived}`,
    );
  }

  updateEndgameDebugIndicator() {
    if (!this.endgameDebugText || !this.castles) return;

    const leftState = this.castles.left.isEndgamePhase ? 'ON' : 'OFF';
    const rightState = this.castles.right.isEndgamePhase ? 'ON' : 'OFF';
    this.endgameDebugText.setText(`LEFT ENDGAME: ${leftState}  |  RIGHT ENDGAME: ${rightState}`);
  }

  teamTitleStyle() {
    return {
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: '42px',
      color: '#fff4cf',
      stroke: '#160b0d',
      strokeThickness: 8,
    };
  }

  scoreStyle() {
    return {
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: '34px',
      color: '#ffd85a',
      stroke: '#160b0d',
      strokeThickness: 6,
    };
  }
}
