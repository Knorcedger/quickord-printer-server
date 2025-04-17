/* eslint-disable no-continue */
/* eslint-disable default-param-last */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */

import { createHash } from 'crypto';
import nconf from 'nconf';
import fs, { createWriteStream } from 'node:fs';
import fsp from 'fs/promises';
import { tmpdir } from 'node:os';
import { dirname, sep } from 'node:path';
import { pipeline } from 'stream/promises';

import { readFile } from 'fs/promises';

import logger from '../modules/logger.ts';

nconf.argv().env().file('./config.json');

let tempDirPath = '';
import JSZip from 'jszip';
async function extractZip(zipBuffer, tempCodePath) {
  const zip = await JSZip.loadAsync(zipBuffer);

  for (const [filename, entry] of Object.entries(zip.files)) {
    const fullPath = `${tempCodePath}${sep}${filename}`;

    if (entry.dir) {
      await fsp.mkdir(fullPath, { recursive: true });
    } else {
      await fsp.mkdir(dirname(fullPath), { recursive: true });
      const content = await entry.nodeStream();
      const writeStream = createWriteStream(fullPath);
      await pipeline(content, writeStream);
    }
  }
}
async function downloadLatestCode() {

  try {
    
    logger.info('Downloading latest code');
  //  const res = await fetch(nconf.get('CODE_UPDATE_URL'));
   const filePath = '../quickord-cashier-server.zip';

   // const res = await fetch(nconf.get('CODE_UPDATE_URL'));
    const fileData = await readFile(filePath);//Buffer.from(await (await res.blob()).arrayBuffer());

    logger.info('Creating temp dir');
    tempDirPath = await fs.promises.mkdtemp(
      `${tmpdir()}${sep}quickord-cashier-server-update`
    );
    
    const zipPath = `${tempDirPath}${sep}quickord-cashier-server.zip`;
    logger.info('Writing zip file');
    await fs.promises.writeFile(zipPath, fileData);

    logger.info('Extracting zip file');
    const tempCodePath = `${tempDirPath}${sep}code`;
    await fs.promises.mkdir(tempCodePath);
   
 
     /*
    try {
      for await (const entry of zip) {
        if (entry.filename.endsWith('\\') || entry.filename.endsWith('/')) {
          await fs.promises.mkdir(`${tempCodePath}${sep}${entry.filename}`);
        } else {
          const readStream = await entry.openReadStream();
          const writeStream = fs.createWriteStream(
            `${tempCodePath}${sep}${entry.filename}`
          );
          await pipeline(readStream, writeStream);
        }
      }
    } finally {
      await zip.close();
    }*/


    const zipBuffer = await fsp.readFile(zipPath);
    await extractZip(zipBuffer, tempCodePath);
                
    return true;
  } catch (e) {
    logger.error(e);
  }

  return false;
}

async function cleanup() {
  if (tempDirPath === '') {
    return;
  }

  logger.info('Deleting temp dir');
  await fs.promises.rm(tempDirPath, { recursive: true });
}

async function readdirRecursive(
  dir: string,
  ignore: Array<string> = [],
  // eslint-disable-next-line no-unused-vars
  fileCallback?: (file: string) => Promise<void>
) {
  const files = await fs.promises.readdir(dir);

  for (const file of files) {
    const filePath = `${dir}${sep}${file}`;
    const stats = await fs.promises.lstat(filePath);

    if (stats.isDirectory()) {
      await readdirRecursive(filePath, ignore, fileCallback);
    } else {
      if (ignore.includes(file.split(sep).pop() || '')) {
        continue;
      }

      await fileCallback?.(filePath);
    }
  }
}

async function md5File(filePath: string) {
  try {
    const file = await fs.promises.readFile(filePath);

    return createHash('md5').update(file).digest('hex');
  } catch (e) {
    logger.error('Error reading file', e);

    return '';
  }
}

async function updateNewExe() {
  const initBatPath = './printerServer.exe';
  const tempInitBatPath = `${tempDirPath}${sep}code${sep}builds${sep}printerServer.exe`;

  let currentInitBat: string;
  let newInitBat: string;

  try {
    currentInitBat = await fs.promises.readFile(initBatPath, 'utf-8');
    newInitBat = await fs.promises.readFile(tempInitBatPath, 'utf-8');
  } catch (e) {
    logger.error('Error reading printerServer.exe', e);
    return;
  }

  const currentInitBatHash = currentInitBat.replace(/(cd).*/g, '');
  const newInitBatHash = newInitBat.replace(/(cd).*/g, '');

  if (currentInitBatHash !== newInitBatHash) {
    logger.info('Updating printerServer.exe');
    try {
      await fs.promises.writeFile(
        initBatPath,
        newInitBat.replace(
          /(cd).*/g,
          currentInitBat.match(/(cd).*/g)?.[0] || ''
        )
      );
    } catch (e) {
      logger.error('Error updating printerServer.exe', e);
    }
  }
}

// eslint-disable-next-line import/prefer-default-export
export default async function autoUpdate() {
  await logger.init('autoupdate');
  return
  try {
    const success = await downloadLatestCode();

    if (success) {
      let currentVersion = '';

      try {
        currentVersion = await fs.promises.readFile('version', 'utf-8');
      } catch (e) {
        logger.warn('cannot find current version file', e);
      }

      let newVersion = '';

      try {
        newVersion = await fs.promises.readFile(
          `${tempDirPath}${sep}code${sep}builds${sep}version`,
          'utf-8'
        );
      } catch (e) {
        logger.warn('cannot find new version file', e);
      }

      logger.info(
        'Current version:',
        currentVersion,
        ' | New version:',
        newVersion
      );
      if (currentVersion === newVersion && newVersion !== '') {
        logger.info('Already up to date');
        return;
      }

      logger.info('Updating code to version', newVersion);

      // read all the downloaded files and their md5 hashes
      await readdirRecursive(
        `${tempDirPath}${sep}code${sep}builds${sep}printerServer.exe`,
        ['printerServer.exe'],
        async (newfile) => {
          const oldFile = newfile.replace(`${tempDirPath}${sep}code${sep}`, '');

          const oldFileHash = await md5File(oldFile);
          const newFileHash = await md5File(newfile);

          if (oldFileHash !== newFileHash) {
            logger.info('    Updating file', oldFile);
            await fs.promises.copyFile(newfile, oldFile);
          }
        }
      );

      await updateNewExe();
    } else {
      logger.error('Failed to download latest code');
    }
  } finally {
    await cleanup();
  }
}

//main();