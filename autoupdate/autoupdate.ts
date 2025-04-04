/* eslint-disable no-continue */
/* eslint-disable default-param-last */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
import { createHash } from 'crypto';
import nconf from 'nconf';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { pipeline } from 'stream/promises';
import yauzl from 'yauzl-promise';

import logger from '../src/modules/logger';

nconf.argv().env().file('./config.json');
import path from 'path';

const replaceExe = (sourceExePath: string, targetExePath: string) => {
  try {
    // Check if source exe exists
    if (!fs.existsSync(sourceExePath)) {
      throw new Error(`Source executable does not exist at: ${sourceExePath}`);
    }

    // Check if target exe exists
    if (!fs.existsSync(targetExePath)) {
      throw new Error(`Target executable does not exist at: ${targetExePath}`);
    }

    // Back up the target exe before replacing it
    const backupPath = targetExePath + '.bak';
    fs.cpSync(targetExePath, backupPath);
    console.log(`Backup created at: ${backupPath}`);

    // Replace the target exe with the new one
    fs.cpSync(sourceExePath, targetExePath);
    console.log(`Replaced ${targetExePath} with ${sourceExePath}`);
  } catch (error) {
    console.error('Error:', error);
  }
};

// Example usage:
const sourceExe = path.join('./dist', 'test.exe');
const targetExe = path.join('./dist', 'printerServer.exe');

const main =  async() => {
  await logger.init('autoupdate');
  console.log("hello world")
};
main();