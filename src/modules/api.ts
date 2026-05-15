import nconf from 'nconf';
import os from 'os';

import logger from './logger';

nconf.argv().env().file({ file: './config.json' });

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

export const apiCall = async (query: string): Promise<any> => {
  const response = await fetch(nconf.get('QUICKORD_API_URL'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: 'desktop_H2WRdpoSEh7iOWD2iCZD7msTKOs',
      appId: 'desktop',
    },
    body: JSON.stringify({ query }),
  });

  const responseJson = (await response.json()) as {
    data?: unknown;
    errors?: unknown;
  };

  if (responseJson?.errors) {
    logger.error('API call error:', JSON.stringify(responseJson.errors));
  }

  return responseJson;
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
