import { Agent, setGlobalDispatcher } from 'undici';

// Node's fetch gives up connecting after 10s. Slow venue uplinks at peak hours
// need longer, and every fetch caller already caps the whole request itself.
export const FETCH_CONNECT_TIMEOUT_MS = 30_000;

setGlobalDispatcher(
  new Agent({ connect: { timeout: FETCH_CONNECT_TIMEOUT_MS } })
);
