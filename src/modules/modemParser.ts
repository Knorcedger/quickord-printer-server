// Pure caller-ID parsing, extracted from modem.ts so it is unit-testable and so
// each modem instance owns its own buffer (a shared one interleaved two lines).

const MAX_BUFFER_LENGTH = 1024;

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
  const buf = buffer + chunk;

  // Complete message = either a newline after the NMBR line or a second RING.
  const hasCompleteNmbr =
    /NMBR\s*=?\s*\+?\d+/.test(buf) &&
    (buf.indexOf('NMBR') < buf.lastIndexOf('\n') ||
      (buf.match(/RING/g)?.length ?? 0) >= 2);

  if (hasCompleteNmbr) {
    const phoneNumber = buf.match(/(?<=NMBR\s*=?\s*)\+?\d+/im)?.[0];
    return { buffer: '', phoneNumber };
  }

  // Prevent the buffer from growing indefinitely if no NMBR arrives.
  if (buf.length > MAX_BUFFER_LENGTH) {
    return { buffer: '', overflowed: buf };
  }

  return { buffer: buf };
};

export default feed;
