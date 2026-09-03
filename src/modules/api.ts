import nconf from 'nconf';
import os from 'os';

import {
  curlExecJson,
  FetchFailureDetails,
  httpStatusError,
  tryFetchWithFallback,
  withTempJsonPayload,
} from './http';
import { FailureEpisode } from './failureEpisode';
import logger from './logger';
import { getVenueId } from './psIdentity';

nconf.argv().env().file({ file: './config.json' });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const APIKEY = 'desktop_H2WRdpoSEh7iOWD2iCZD7msTKOs';
const APPID = 'desktop';

// Null when no usable LAN IPv4 is up (DHCP not settled at boot, or only
// virtual adapters). Never falls back to loopback or — unless the caller opts
// in — to a Hyper-V/WSL/Docker address: a wrong IP published to the backend
// kills LAN printing for the whole venue and nothing re-registers it.
export const getLocalIP = (
  options: { allowVirtual?: boolean } = {}
): string | null => {
  const interfaces = os.networkInterfaces();

  // Skip virtual/container interfaces that may shadow the real LAN IP
  const virtualPatterns =
    /^(vEthernet|WSL|docker|br-|veth|Hyper-V|VMware|VirtualBox|virbr)/i;

  let virtual: string | null = null;

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;

    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        if (virtualPatterns.test(name)) {
          if (!virtual) virtual = alias.address;
        } else {
          return alias.address;
        }
      }
    }
  }
  return options.allowVirtual ? virtual : null;
};

const escapeGraphqlString = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

// Builds the `addError` mutation shared by every failure reporter. The BE logs
// each addError with a "Problem:" prefix, surfacing it as a Slack incident.
// Centralized so the fetch-failure and websocket-failure reporters can't drift
// in escaping or envelope shape.
const buildAddErrorMutation = (
  message: string,
  url: string,
  details: Record<string, unknown>
): string =>
  `mutation { addError(message: "${escapeGraphqlString(message)}", url: "${escapeGraphqlString(url)}", query: "${escapeGraphqlString(JSON.stringify(details))}") { _id } }`;

// Reports a printer-server fetch failure to the BE by calling the existing
// `addError` GraphQL mutation. Uses curl directly to avoid recursion through
// the fetch path that just failed. Skipped when the network is fully down.
const reportFetchFailure = async (
  failure: FetchFailureDetails
): Promise<void> => {
  if (failure.networkDown) return;

  const apiUrl = nconf.get('QUICKORD_API_URL');
  if (!apiUrl) return;

  // Every venue reports the same method+url, so without the venueId an incident
  // is unattributable — the ErrorModel has no venueId column and addError does
  // not persist the caller's IP. Carried in both the message (what Slack shows)
  // and the details.
  const venueId = getVenueId() || 'unknown';

  // The streak is the headline: it's what says fetch is broken here rather than
  // blipping. socketReused=false alongside it rules out stale keep-alive.
  const streak = failure.consecutiveFallbacks;
  const message = `Problem: printer-server fetch failed for ${failure.method} ${failure.url} for venue ${venueId} — ${failure.fetchErrorName || 'Error'}: ${failure.fetchErrorMessage || 'unknown'} (fetch tried ${failure.fetchAttempts}×, curl ${failure.curlOk ? 'ok' : 'failed'}${streak ? `, ${streak} consecutive fallbacks` : ''})`;
  const mutation = buildAddErrorMutation(message, failure.url, {
    consecutiveFallbacks: failure.consecutiveFallbacks,
    curlDurationMs: failure.curlDurationMs,
    curlOk: failure.curlOk,
    fetchAttempts: failure.fetchAttempts,
    fetchDurationMs: failure.fetchDurationMs,
    fetchErrorCause: failure.fetchErrorCause,
    fetchErrorCode: failure.fetchErrorCode,
    responseStatus: failure.responseStatus,
    socketReused: failure.socketReused,
    venueId,
  });

  try {
    await withTempJsonPayload({ query: mutation }, (tempFilePath) =>
      curlExecJson(
        `curl -s -X POST "${apiUrl}" -H "Content-Type: application/json" -H "apikey: ${APIKEY}" -H "appId: ${APPID}" --data-binary "@${tempFilePath}"`
      )
    );
    logger.info('Reported fetch failure to BE');
  } catch (err) {
    logger.error('Failed to report fetch failure to BE:', err);
  }
};

export const apiCall = async (
  query: string,
  opts: { suppressFailureLogs?: boolean } = {}
): Promise<any> => {
  const apiUrl = nconf.get('QUICKORD_API_URL');

  const result = await tryFetchWithFallback<{ data?: any; errors?: any }>({
    url: apiUrl,
    method: 'POST',
    suppressFailureLogs: opts.suppressFailureLogs,
    fetchFn: async () => {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: APIKEY,
          appId: APPID,
        },
        body: JSON.stringify({ query }),
      });
      if (!response.ok) throw httpStatusError(response);
      const data = (await response.json()) as { data?: any; errors?: any };
      return { data };
    },
    curlFn: () =>
      withTempJsonPayload({ query }, (tempFilePath) =>
        curlExecJson(
          `curl -s -X POST "${apiUrl}" -H "Content-Type: application/json" -H "apikey: ${APIKEY}" -H "appId: ${APPID}" --data-binary "@${tempFilePath}"`
        )
      ),
  });

  if (result.viaFallback && result.fetchFailure) {
    reportFetchFailure(result.fetchFailure).catch(() => {});
  }

  if (result.data?.errors && !opts.suppressFailureLogs) {
    logger.error('API call error:', JSON.stringify(result.data.errors));
  }

  return result.data;
};

// One attempt. True on a confirmed 'ok'; anything else throws, so the retry
// loop below owns all the logging for a run of failed attempts.
export const registerPrinterServerIp = async (
  venueId: string,
  opts: { ip?: string | null; quiet?: boolean } = {}
): Promise<boolean> => {
  const localIp = opts.ip === undefined ? getLocalIP() : opts.ip;
  if (!localIp) return false;

  if (!opts.quiet) {
    logger.info(
      `Registering printer server IP: ${localIp} for venue: ${venueId}`
    );
  }

  const res = await apiCall(
    `mutation { updatePrinterServerIp(venueId: "${venueId}", ip: "${localIp}") { status ip } }`,
    { suppressFailureLogs: opts.quiet }
  );

  if (res?.errors) {
    throw new Error(
      `updatePrinterServerIp returned errors: ${JSON.stringify(res.errors)}`
    );
  }
  if (res?.data?.updatePrinterServerIp?.status !== 'ok') {
    throw new Error(
      `updatePrinterServerIp was not confirmed: ${JSON.stringify(res?.data ?? null)}`
    );
  }

  logger.info('Printer server IP registered successfully');
  return true;
};

const IP_REGISTRATION_RETRY_MS = 15_000;
// A dead uplink lasts hours, and every attempt costs a fetch plus a curl
// process, so slow down once a boot-time DHCP race is no longer the likely
// cause. Registration is not latency-critical: it only enables the FE's
// direct-LAN fast path.
const IP_REGISTRATION_SLOW_RETRY_MS = 60_000;
const IP_REGISTRATION_FAST_ATTEMPTS = 4;
// Only virtual adapters up right after boot means DHCP hasn't settled. Past
// this window it's the machine's real address — on a Hyper-V external switch
// the host's LAN IP genuinely lives on a vEthernet adapter.
const VIRTUAL_IP_GRACE_MS = 5 * 60 * 1000;

let ipRegistrationVenueId: string | null = null;

// Retries until the backend confirms once, then stops. The PS must not block on
// this: it only enables the FE's direct-LAN fast path, while the pull channel —
// which does the printing — needs no IP at all. At boot the service starts
// before DHCP has a lease, so the first attempts legitimately have nothing to
// publish.
export const startPrinterServerIpRegistration = (venueId: string): void => {
  if (ipRegistrationVenueId === venueId) return;
  ipRegistrationVenueId = venueId;

  void (async () => {
    const episode = new FailureEpisode('Printer server IP registration');
    const startedAt = Date.now();
    let waitingLogged = false;

    while (ipRegistrationVenueId === venueId) {
      const ip = getLocalIP({
        allowVirtual: Date.now() - startedAt >= VIRTUAL_IP_GRACE_MS,
      });

      if (!ip) {
        if (!waitingLogged) {
          waitingLogged = true;
          logger.warn(
            `No LAN IPv4 yet — deferring printer server IP registration, retrying every ${IP_REGISTRATION_RETRY_MS}ms`
          );
        }
      } else {
        waitingLogged = false;
        try {
          // quiet from the second attempt on: the first failure's full dump is
          // already in the log and the episode carries the rest.
          if (
            await registerPrinterServerIp(venueId, {
              ip,
              quiet: episode.active,
            })
          ) {
            episode.succeed();
            return;
          }
          episode.fail(new Error('no LAN IPv4 to register'));
        } catch (err) {
          episode.fail(err);
        }
      }

      await sleep(
        episode.failureCount >= IP_REGISTRATION_FAST_ATTEMPTS
          ? IP_REGISTRATION_SLOW_RETRY_MS
          : IP_REGISTRATION_RETRY_MS
      );
    }
  })();
};

export { reportFetchFailure };
