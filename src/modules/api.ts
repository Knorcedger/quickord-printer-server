import nconf from 'nconf';
import os from 'os';

import {
  curlExecJson,
  FetchFailureDetails,
  httpStatusError,
  tryFetchWithFallback,
  withTempJsonPayload,
} from './http';
import logger from './logger';
import { getVenueId } from './psIdentity';

nconf.argv().env().file({ file: './config.json' });

const APIKEY = 'desktop_H2WRdpoSEh7iOWD2iCZD7msTKOs';
const APPID = 'desktop';

// Null when no LAN IPv4 is up yet (DHCP not settled at boot). Never falls back
// to loopback: a 127.0.0.1 published to the backend kills LAN printing for the
// whole venue, and nothing re-registers it until the process restarts.
export const getLocalIP = (): string | null => {
  const interfaces = os.networkInterfaces();

  // Skip virtual/container interfaces that may shadow the real LAN IP
  const virtualPatterns =
    /^(vEthernet|WSL|docker|br-|veth|Hyper-V|VMware|VirtualBox|virbr)/i;

  let fallback: string | null = null;

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;

    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        if (virtualPatterns.test(name)) {
          console.log('hit virtualPatterns:', name);
          if (!fallback) fallback = alias.address;
        } else {
          return alias.address;
        }
      }
    }
  }
  return fallback;
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

export const apiCall = async (query: string): Promise<any> => {
  const apiUrl = nconf.get('QUICKORD_API_URL');

  const result = await tryFetchWithFallback<{ data?: any; errors?: any }>({
    url: apiUrl,
    method: 'POST',
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

  if (result.data?.errors) {
    logger.error('API call error:', JSON.stringify(result.data.errors));
  }

  return result.data;
};

// One registration attempt. Resolves true only on a confirmed 'ok' — anything
// else is retried by the caller.
export const registerPrinterServerIp = async (
  venueId: string
): Promise<boolean> => {
  const localIp = getLocalIP();
  if (!localIp) return false;

  logger.info(
    `Registering printer server IP: ${localIp} for venue: ${venueId}`
  );

  try {
    const res = await apiCall(
      `mutation { updatePrinterServerIp(venueId: "${venueId}", ip: "${localIp}") { status ip } }`
    );

    if (res?.errors) {
      logger.error(
        'Failed to register printer server IP:',
        JSON.stringify(res.errors)
      );
      return false;
    }
    if (res?.data?.updatePrinterServerIp?.status === 'ok') {
      logger.info('Printer server IP registered successfully');
      return true;
    }
    return false;
  } catch (err) {
    logger.error('Failed to register printer server IP:', err);
    return false;
  }
};

const IP_REGISTRATION_RETRY_MS = 15_000;
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
    let waitingLogged = false;
    while (ipRegistrationVenueId === venueId) {
      if (!getLocalIP()) {
        if (!waitingLogged) {
          waitingLogged = true;
          logger.warn(
            `No LAN IPv4 yet — deferring printer server IP registration, retrying every ${IP_REGISTRATION_RETRY_MS}ms`
          );
        }
      } else {
        waitingLogged = false;
        if (await registerPrinterServerIp(venueId)) return;
      }
      await new Promise((r) => setTimeout(r, IP_REGISTRATION_RETRY_MS));
    }
  })();
};

export { reportFetchFailure };
