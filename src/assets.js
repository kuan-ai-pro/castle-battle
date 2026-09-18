const pngAssets = import.meta.glob('./assets/**/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

const normalizedEntries = Object.entries(pngAssets).map(([path, url]) => ({
  path: path.replace('./assets/', ''),
  url,
}));

function findAsset(relativePath) {
  const match = normalizedEntries.find((entry) => entry.path === relativePath);

  if (!match) {
    throw new Error(`Asset not found: ${relativePath}`);
  }

  return match.url;
}

function collectFrames(color, action) {
  const folder = `${color} ${action}/`;
  const filePrefix = `${color}_${action}_`;

  return normalizedEntries
    .filter(({ path }) => path.startsWith(folder) && path.endsWith('.png'))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    .map(({ path, url }, index) => ({
      key: `${color}-${action}-${index}`,
      path,
      url,
    }));
}

export const sceneAssets = {
  background: findAsset('Background.png'),
  castles: {
    red: {
      0: findAsset('Red Castle/red_castle_0.png'),
      30: findAsset('Red Castle/red_castle_30.png'),
      50: findAsset('Red Castle/red_castle_50.png'),
      70: findAsset('Red Castle/red_castle_70.png'),
      100: findAsset('Red Castle/red_castle_100.png'),
    },
    blue: {
      0: findAsset('Blue Castle/blue_castle_0.png'),
      30: findAsset('Blue Castle/blue_castle_30.png'),
      50: findAsset('Blue Castle/blue_castle_50.png'),
      70: findAsset('Blue Castle/blue_castle_70.png'),
      100: findAsset('Blue Castle/blue_castle_100.png'),
    },
  },
};

export const frameCatalog = {
  red: {
    walk: collectFrames('red', 'walk'),
    attack: collectFrames('red', 'attack'),
    die: collectFrames('red', 'die'),
  },
  blue: {
    walk: collectFrames('blue', 'walk'),
    attack: collectFrames('blue', 'attack'),
    die: collectFrames('blue', 'die'),
  },
};
