import {
  ControlEvent,
  TikTokLiveConnection,
  WebcastEvent,
} from 'tiktok-live-connector';

export const TIKTOK_USERNAME = 'TIKTOK_USERNAME';
export const EULER_API_KEY = 'EULER_API_KEY';
export const RETRY_DELAY_MS = 15_000;

export function hasTikTokCredentials() {
  return (
    TIKTOK_USERNAME !== 'TIKTOK_USERNAME'
    && EULER_API_KEY !== 'EULER_API_KEY'
  );
}

export function createTikTokConnection() {
  return new TikTokLiveConnection(TIKTOK_USERNAME, {
    enableExtendedGiftInfo: true,
    signApiKey: EULER_API_KEY,
  });
}

export function registerTikTokGiftHandler(connection, onGift) {
  connection.on(WebcastEvent.GIFT, (data) => {
    const giftType = data.giftDetails?.giftType;
    if (giftType === 1 && data.repeatEnd === false) return;

    onGift({
      giftId: data.giftId,
      giftType,
      giftName: data.giftDetails?.giftName,
      repeatCount: Math.max(1, Number(data.repeatCount) || 1),
      uniqueId: data.user?.uniqueId || data.user?.nickname || 'anonymous',
    });
  });
}

export function startTikTokConnection(connection) {
  let retryTimer = null;
  let isConnecting = false;

  const scheduleReconnect = () => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, RETRY_DELAY_MS);
  };

  const connect = async () => {
    if (isConnecting || connection.isConnected) return;
    isConnecting = true;

    try {
      const state = await connection.connect();
      console.log(`TikTok LIVE connected: @${TIKTOK_USERNAME}, room ${state.roomId}`);
    } catch (error) {
      console.error(`TikTok LIVE connection failed for @${TIKTOK_USERNAME}:`, error);
      scheduleReconnect();
    } finally {
      isConnecting = false;
    }
  };

  connection.on(ControlEvent.DISCONNECTED, scheduleReconnect);
  connect();
}
