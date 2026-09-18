export class SpawnQueue {
  constructor({ aggregationWindowMs = 500, now = Date.now } = {}) {
    this.queue = [];
    this.aggregationWindowMs = aggregationWindowMs;
    this.now = now;
  }

  push(payload) {
    const now = this.now();
    const lastItem = this.queue[this.queue.length - 1];
    const canAggregate = Boolean(
      lastItem
      && lastItem.team === payload.team
      && lastItem.donor === payload.donor
      && lastItem.giftId === payload.giftId
      && now - lastItem.lastUpdate < this.aggregationWindowMs
    );

    if (canAggregate) {
      lastItem.count += 1;
      lastItem.lastUpdate = now;
      return lastItem;
    }

    const item = {
      team: payload.team,
      donor: payload.donor,
      giftId: payload.giftId,
      count: 1,
      createdAt: now,
      lastUpdate: now,
    };
    this.queue.push(item);
    return item;
  }

  drainReady() {
    const now = this.now();
    const ready = [];
    while (
      this.queue.length > 0
      && now - this.queue[0].lastUpdate >= this.aggregationWindowMs
    ) {
      ready.push(this.queue.shift());
    }
    return ready;
  }

  clear() {
    this.queue.length = 0;
  }
}
