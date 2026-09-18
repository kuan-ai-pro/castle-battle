import express from 'express';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import {
  createTikTokConnection,
  hasTikTokCredentials,
  registerTikTokGiftHandler,
  startTikTokConnection,
} from './tiktok-live.js';

const PORT = Number(process.env.PORT) || 3001;
const giftMapping = JSON.parse(
  readFileSync(new URL('./giftMapping.json', import.meta.url), 'utf8'),
);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

function emitSpawnKnight({ team, donor, giftId }) {
  const payload = {
    type: 'spawn-knight',
    team,
    donor,
    giftId: String(giftId),
  };
  io.emit('spawn-knight', payload);
  console.log('spawn-knight:', JSON.stringify(payload));
}

function processGift({ giftId, giftType, giftName, repeatCount, uniqueId }) {
  const team = giftMapping[String(giftId)];
  if (team !== 'left' && team !== 'right') {
    console.warn(`Ignoring unmapped gift: ${giftId} (${giftName || 'unknown'})`);
    return;
  }

  const count = giftType === 1 ? repeatCount : 1;
  for (let index = 0; index < count; index += 1) {
    emitSpawnKnight({ team, donor: uniqueId, giftId });
  }
}

app.get('/test', (request, response) => {
  const giftId = String(request.query.giftId || '5655');
  const team = giftMapping[giftId];
  if (team !== 'left' && team !== 'right') {
    response.status(400).send('Unknown giftId. Try 5655, 5269, 5487 or 105781.');
    return;
  }

  emitSpawnKnight({
    team,
    donor: String(request.query.donor || 'test-viewer'),
    giftId,
  });
  response.send(`Spawned ${team} knight for gift ${giftId}`);
});

io.on('connection', (socket) => {
  console.log(`Game connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`Game disconnected: ${socket.id}`));
});

httpServer.listen(PORT, () => {
  console.log(`GiftProvider listening on http://localhost:${PORT}`);
  console.log(`Test: http://localhost:${PORT}/test?giftId=5655&donor=test-viewer`);
});

if (hasTikTokCredentials()) {
  const connection = createTikTokConnection();
  registerTikTokGiftHandler(connection, processGift);
  startTikTokConnection(connection);
} else {
  console.warn('TikTok LIVE disabled: set TIKTOK_USERNAME and EULER_API_KEY in tiktok-live.js.');
}
