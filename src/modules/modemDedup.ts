// Safety net for routers that ring both FXS ports on every incoming call: two
// modems would then report the same call and the backend does no dedup, so the
// venue gets two CallHistory records and two popups.

const WINDOW_MS = 5_000;
const MAX_ENTRIES = 200;

const seen = new Map<string, number>();

// Same call in any format -> same key.
const normalize = (phoneNumber: string) =>
  phoneNumber.replace(/\D/g, '').slice(-10);

export const shouldEmit = (phoneNumber: string, now = Date.now()): boolean => {
  const key = normalize(phoneNumber);
  const last = seen.get(key);

  if (last !== undefined && now - last < WINDOW_MS) return false;

  seen.set(key, now);

  if (seen.size > MAX_ENTRIES) {
    seen.forEach((ts, k) => {
      if (now - ts > WINDOW_MS) seen.delete(k);
    });
  }

  return true;
};

// Tests only.
export const __resetDedup = () => seen.clear();
