import { io } from 'socket.io-client';

const GIFT_PROVIDER_URL = 'http://localhost:3001';

export function connectGiftSocket(onSpawnKnight) {
  const socket = io(GIFT_PROVIDER_URL);

  socket.on('connect', () => console.log('GiftProvider connected'));
  socket.on('disconnect', () => console.warn('GiftProvider disconnected'));
  socket.on('connect_error', (error) => console.warn('GiftProvider connection error:', error.message));
  socket.on('spawn-knight', (payload) => {
    if (
      payload?.type !== 'spawn-knight'
      || (payload.team !== 'left' && payload.team !== 'right')
    ) {
      console.warn('Ignoring invalid spawn-knight payload:', payload);
      return;
    }

    onSpawnKnight({
      team: payload.team,
      donor: String(payload.donor || 'anonymous'),
      giftId: String(payload.giftId || 'unknown'),
    });
  });

  return socket;
}
