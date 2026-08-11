// Pure caller-ID parsing, extracted from modem.ts so it is unit-testable and so
// each modem instance owns its own buffer (a shared one interleaved two lines).

const MAX_BUFFER_LENGTH = 1024;

// On overflow, a trailing incomplete line up to this long survives so a CID
// burst arriving at that exact moment is not lost.
const MAX_TAIL_KEEP = 64;

// Keepalive/init chatter — command echoes and result codes, never CID data.
const NOISE_LINE = /^(AT.*|OK|ERROR)$/i;

export type FeedResult = {
  buffer: string;
  // Content dropped by the overflow guard, for the caller to log.
  overflowed?: string;
  phoneNumber?: string;
};

// Expected modem CID formats:
// Direct modem:          CHC (virtual COM):
// RING                   RING
// DATE = 0718            DATE 0408
// TIME = 1730            TIME 1355
// NMBR = 1234567890      NMBR 6976641604
// RING
export const feed = (buffer: string, chunk: string): FeedResult => {
  const raw = buffer + chunk;

  // Complete message = either a newline after the NMBR line or a second RING.
  const hasCompleteNmbr =
    /NMBR\s*=?\s*\+?\d+/.test(raw) &&
    (raw.indexOf('NMBR') < raw.lastIndexOf('\n') ||
      (raw.match(/RING/g)?.length ?? 0) >= 2);

  if (hasCompleteNmbr) {
    const phoneNumber = raw.match(/(?<=NMBR\s*=?\s*)\+?\d+/im)?.[0];
    return { buffer: '', phoneNumber };
  }

  // Drop completed noise lines so keepalive traffic never fills the buffer.
  // The trailing incomplete line is kept verbatim.
  const lastNl = raw.lastIndexOf('\n');
  const tail = raw.slice(lastNl + 1);
  const buf =
    lastNl === -1
      ? raw
      : raw
          .slice(0, lastNl + 1)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== '' && !NOISE_LINE.test(line))
          .map((line) => `${line}\r\n`)
          .join('') + tail;

  // Prevent the buffer from growing indefinitely if no NMBR arrives.
  if (buf.length > MAX_BUFFER_LENGTH) {
    const keep = tail.length <= MAX_TAIL_KEEP ? tail : '';
    return { buffer: keep, overflowed: buf.slice(0, buf.length - keep.length) };
  }

  return { buffer: buf };
};

export default feed;
