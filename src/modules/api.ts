import { exec } from 'child_process';
import fs from 'fs';
import nconf from 'nconf';
import os from 'os';
import path from 'path';

import logger from './logger';

nconf.argv().env().file({ file: './config.json' });

const execAsync = (cmd: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf-8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
};

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
          // Keep as fallback in case no real interface is found
          if (!fallback) fallback = alias.address;
        } else {
          return alias.address;
        }
      }
    }
  }
  return fallback || '127.0.0.1';
};

/**
 * Makes a GraphQL API call to the Quickord backend using curl.
 * Curl is used instead of fetch to bypass SSL certificate issues in the bundled executable (nexe).
 */
export const apiCall = async (query: string): Promise<any> => {
  let tempFilePath: string | null = null;

  try {
    const payload = { query };

    // Write payload to temp file to avoid escaping issues on Windows
    tempFilePath = path.join(os.tmpdir(), `api-payload-${Date.now()}.json`);
    fs.writeFileSync(tempFilePath, JSON.stringify(payload));

    const curlCmd = `curl -s -X POST "${nconf.get('QUICKORD_API_URL')}" -H "Content-Type: application/json" -H "apikey: desktop_H2WRdpoSEh7iOWD2iCZD7msTKOs" -H "appId: desktop" --data-binary "@${tempFilePath}"`;

    const response = await execAsync(curlCmd);
    const responseJson = JSON.parse(response);

    if (responseJson?.errors) {
      logger.error('API call error:', JSON.stringify(responseJson.errors));
    }

    return responseJson;
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
};
