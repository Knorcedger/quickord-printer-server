import { Agent, setGlobalDispatcher } from 'undici';

// Node's fetch gives up connecting after 10s; slow venue uplinks need longer.
// Kept under Windows' own ~21s SYN give-up, so a stalled connect always ends as
// UND_ERR_CONNECT_TIMEOUT rather than an OS ETIMEDOUT.
export const FETCH_CONNECT_TIMEOUT_MS = 20_000;

setGlobalDispatcher(
  new Agent({ connect: { timeout: FETCH_CONNECT_TIMEOUT_MS } })
);
