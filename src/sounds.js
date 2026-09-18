const audioFiles = import.meta.glob('../sounds/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default',
});

function findSound(fileName) {
  const entry = Object.entries(audioFiles).find(([path]) => path.endsWith(`/${fileName}`));

  if (!entry) {
    throw new Error(`Sound not found: ${fileName}`);
  }

  return entry[1];
}

export const soundAssets = {
  'sword-hit-1': findSound('sword_hit_1.mp3'),
  'sword-hit-2': findSound('sword_hit_2.mp3'),
  'sword-hit-3': findSound('sword_hit_3.mp3'),
  'sword-hit-4': findSound('sword_hit_4.mp3'),
  'castle-hit-1': findSound('castle_hit_1.mp3'),
  'castle-hit-2': findSound('castle_hit_2.mp3'),
  'castle-hit-3': findSound('castle_hit_3.mp3'),
  'knight-death-1': findSound('knight_death_1.mp3'),
  'knight-death-2': findSound('knight_death_2.mp3'),
  'knight-death-3': findSound('knight_death_3.mp3'),
  'knight-spawn': findSound('knight_spawn.mp3'),
  'castle-crack': findSound('castle_crack.mp3'),
  'go-almaty': findSound('go_almaty.mp3'),
  'go-shymkent': findSound('go_shymkent.mp3'),
  'war-cry': findSound('war_cry.mp3'),
  'castle-explode': findSound('castle_explode.mp3'),
  'endgame-alarm': findSound('endgame_alarm.mp3.mp3'),
  'combo-start': findSound('combo_start.mp3'),
  'combo-rise': findSound('combo_rise.mp3'),
  victory: findSound('victory.mp3'),
};

export const soundVariants = {
  swordHit: ['sword-hit-1', 'sword-hit-2', 'sword-hit-3', 'sword-hit-4'],
  castleHit: ['castle-hit-1', 'castle-hit-2', 'castle-hit-3'],
  knightDeath: ['knight-death-1', 'knight-death-2', 'knight-death-3'],
};
