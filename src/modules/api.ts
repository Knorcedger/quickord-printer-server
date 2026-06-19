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

nconf.argv().env().file({ file: './config.json' });

const APIKEY = 'desktop_H2WRdpoSEh7iOWD2iCZD7msTKOs';
const APPID = 'desktop';

export const getLocalIP = (): string => {
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
  return fallback || '127.0.0.1';
};

const escapeGraphqlString = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

// Reports a printer-server fetch failure to the BE by calling the existing
// `addError` GraphQL mutation. Uses curl directly to avoid recursion through
// the fetch path that just failed. Skipped when the network is fully down.
const reportFetchFailure = async (
  failure: FetchFailureDetails
): Promise<void> => {
  if (failure.networkDown) return;

  const apiUrl = nconf.get('QUICKORD_API_URL');
  if (!apiUrl) return;

  const message = `Problem: printer-server fetch failed for ${failure.method} ${failure.url} — ${failure.fetchErrorName || 'Error'}: ${failure.fetchErrorMessage || 'unknown'}`;
  const detailsJson = JSON.stringify({
    fetchErrorCode: failure.fetchErrorCode,
    fetchErrorCause: failure.fetchErrorCause,
    responseStatus: failure.responseStatus,
    curlOk: failure.curlOk,
  });

  const mutation = `mutation { addError(message: "${escapeGraphqlString(message)}", url: "${escapeGraphqlString(failure.url)}", query: "${escapeGraphqlString(detailsJson)}") { _id } }`;

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

// Reports a printer-server WebSocket connection failure to the BE via the same
// `addError` mutation as fetch failures — the BE logs every addError with a
// "Problem:" prefix, so it surfaces as a Slack incident. Goes through apiCall
// (fetch-first, curl fallback): the WS upgrade was rejected, but plain HTTPS to
// the GraphQL endpoint usually still works, and curl covers the proxy case.
const reportWebSocketFailure = async (details: {
  attempts: number;
  category: string;
  code: string;
  message: string;
  url: string;
  venueId: string;
}): Promise<void> => {
  const message = `Problem: printer-server cannot open its WebSocket to ${details.url} for venue ${details.venueId} after ${details.attempts} attempts — ${details.category} (${details.code}): ${details.message}. Backend->printer dispatch is down for this venue.`;
  const detailsJson = JSON.stringify({
    attempts: details.attempts,
    category: details.category,
    code: details.code,
    venueId: details.venueId,
  });

  const mutation = `mutation { addError(message: "${escapeGraphqlString(message)}", url: "${escapeGraphqlString(details.url)}", query: "${escapeGraphqlString(detailsJson)}") { _id } }`;

  try {
    await apiCall(mutation);
    logger.info('Reported WebSocket connection failure to BE');
  } catch (err) {
    logger.error('Failed to report WebSocket connection failure to BE:', err);
  }
};

export const registerPrinterServerIp = async (
  venueId: string
): Promise<void> => {
  const localIp = getLocalIP();
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
    } else if (res?.data?.updatePrinterServerIp?.status === 'ok') {
      logger.info('Printer server IP registered successfully');
    }
  } catch (err) {
    logger.error('Failed to register printer server IP:', err);
  }
};

export { reportFetchFailure, reportWebSocketFailure };
