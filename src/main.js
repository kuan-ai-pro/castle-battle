import Phaser from 'phaser';
import { CastleBattleScene } from './CastleBattleScene.js';
import { GAME_HEIGHT, GAME_WIDTH } from './config.js';
import './style.css';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  disableVisibilityChange: true,
  backgroundColor: '#09070d',
  scene: [CastleBattleScene],
  render: {
    antialias: true,
    pixelArt: false,
    roundPixels: true,
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
  },
});

window.castleBattle = game;
