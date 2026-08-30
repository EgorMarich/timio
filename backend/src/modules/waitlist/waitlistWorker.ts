import { sweepExpiredInvites } from './waitlist.service.js';

export function startWaitlistWorker(): void {
  const intervalMs = Number(process.env.WAITLIST_SWEEP_INTERVAL_MS ?? 60_000);

  setInterval(() => {
    sweepExpiredInvites().catch((err) => {
      console.error('[WaitlistWorker] sweep error:', err);
    });
  }, intervalMs);

  console.log(`[WaitlistWorker] started, sweep every ${intervalMs / 1000}s`);
}