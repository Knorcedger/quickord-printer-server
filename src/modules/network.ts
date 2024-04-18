/* eslint-disable consistent-return */
import { execSync } from 'child_process';
import { Request, Response } from 'express';
import network from 'network';

import logger from './logger';

let IS_NMAP_INSTALLED = false;

export const initNetWorkScanner = async () => {
  const OS = process.platform;

  const isNmapInstalled =
    OS === 'linux'
      ? execSync('nmap --version').toString()
      : execSync('where nmap').toString();

  if (isNmapInstalled.toLowerCase().includes('nmap version ')) {
    logger.info('nmap is already installed');
    IS_NMAP_INSTALLED = true;
    return;
  }

  if (OS !== 'win32') {
    logger.error(
      'nmap is not installed, OS is not win32 please install nmap manually.'
    );
    return;
  }

  try {
    logger.info('Installing nmap on Windows');
    execSync('./binaries/npcap-1.79.exe /q');
    execSync('./binaries/nmap-7.94-setup.exe /q /x');
    logger.info('nmap installed');
    IS_NMAP_INSTALLED = true;
  } catch (error) {
    logger.error('Error installing nmap:', error);
  }
};

export const scanNetworkForPrinters = async () => {
  if (!IS_NMAP_INSTALLED) {
    logger.error('nmap is not installed, cannot scan network.');
    return [];
  }

  return new Promise((resolve, reject) => {
    network.get_gateway_ip(async (err, ip) => {
      if (err) {
        logger.error('Error getting gateway ip:', err);
        return reject(err);
      }

      try {
        logger.info('Scanning network for printers');
        const IPs = execSync(`nmap -sn ${ip}/24`).toString();
        logger.info('Network scan info received:', IPs);

        const printers: Array<Array<string>> = [];

        IPs.split('\n').forEach((line) => {
          if (line.toLowerCase().includes('prn')) {
            const printerName = line.split(' ')[4];

            const printerIp = line.split(' ')[5];

            if (!printerIp) return;

            printers.push([printerName || 'Unknown', printerIp]);
          }
        });

        resolve(printers);
      } catch (error) {
        logger.error('Error scanning network:', error);
        return reject(error);
      }
    });
  });
};

export const networkResolver = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    res.status(200).send({ printers: await scanNetworkForPrinters() });
  } catch (error) {
    logger.error('Error scanning network:', error);
    res.status(400).send({ error: error.message });
  }
};
