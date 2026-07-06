/**
 * Single source for deriving backend endpoints from QUICKORD_API_URL, so the
 * WebSocket channel and the HTTP pull channel can never point at different
 * hosts (they previously each re-derived the base with different strip rules).
 */
import nconf from 'nconf';

nconf.argv().env().file({ file: './config.json' });

const DEFAULT_API_URL = 'https://api.quickord.com/graphql';

// Backend HTTP base (no /graphql). Overridable via BACKEND_HTTP_URL for
// non-standard deployments. The anchored regex only strips a trailing
// /graphql, so a host like graphql.example.com survives intact.
export function getBackendBaseUrl(): string {
  const explicit = nconf.get('BACKEND_HTTP_URL');
  if (explicit) return explicit;
  const apiUrl = nconf.get('QUICKORD_API_URL') || DEFAULT_API_URL;
  return apiUrl.replace(/\/graphql\/?$/, '');
}

// Backend WebSocket URL, derived from the same base. Overridable via
// BACKEND_WS_URL.
export function getBackendWsUrl(): string {
  const wsUrl = nconf.get('BACKEND_WS_URL');
  if (wsUrl) return wsUrl;
  return getBackendBaseUrl()
    .replace('https://', 'wss://')
    .replace('http://', 'ws://');
}
