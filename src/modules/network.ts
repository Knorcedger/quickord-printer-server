/* eslint-disable consistent-return */
import network from 'network';
import { exec, execSync } from 'node:child_process';
import process from 'node:process';

import logger from './logger.ts';

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
    execSync('./binaries/npcap-1.79.exe /quiet /norestart');
    execSync('./binaries/nmap-7.94-setup.exe /quiet /norestart');
    logger.info('nmap installed');
    IS_NMAP_INSTALLED = true;
  } catch (error) {
    logger.error('Error installing nmap:', error);
  }
};

const execPromise = (command: string) => {
  return new Promise((resolve, reject) => {
    exec(command, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(stdout);
    });
  });
};

export const scanNetworkForConnections = async (): Promise<
  Array<Array<string>>
> => {
  if (!IS_NMAP_INSTALLED) {
    logger.error('nmap is not installed, cannot scan network.');
    return [];
  }

  return new Promise((resolve, reject) => {
    network.get_gateway_ip(async (err: any, ip: string) => {
      if (err) {
        logger.error('Error getting gateway ip:', err);
        reject(err);
        return;
      }

      try {
        logger.info('Scanning network');
        let IPs = '';

        if (process.platform === 'win32') {
          IPs = (
            (await execPromise(`nmap -sn ${ip}/24`)) as any
          ).toString() as string;
        } else if (process.platform === 'linux') {
          IPs = (
            (await execPromise(`nmap -sn ${ip}/24`)) as any
          ).toString() as string;
        }
        logger.info('Network scan info received:', IPs);

        const connections: Array<Array<string>> = [];

        IPs.split('\n').forEach((line) => {
          if (line.includes('Nmap scan report for')) {
            const info = line.split('Nmap scan report for ')[1] || '';
            let connectionName = info.split(' ')[0];

            let connectionIp = info
              .split(' ')[1]
              ?.replace('(', '')
              .replace(')', '');

            if (!connectionIp) {
              connectionIp = connectionName;
              connectionName = '';
            }

            connections.push([connectionName || 'Unknown', connectionIp || '']);
          }
        });

        resolve(connections);
      } catch (error) {
        logger.error('Error scanning network:', error);
        reject(error);
      }
    });
  }) as Promise<Array<Array<string>>>;
};
