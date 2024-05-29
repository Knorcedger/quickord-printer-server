/* eslint-disable no-continue */
/* eslint-disable default-param-last */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-console */

import { createHash } from 'crypto';
import fs from 'fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { pipeline } from 'stream/promises';
import yauzl from 'yauzl-promise';

let tempDirPath = '';

async function downloadLatestCode() {
  try {
    console.log('Downloading latest code');
    const res = await fetch(
      'https://github.com/Knorcedger/quickord-printer-server/releases/latest/download/quickord-cashier-server.zip'
    );

    const fileData = Buffer.from(await (await res.blob()).arrayBuffer());

    console.log('Creating temp dir');
    tempDirPath = await fs.promises.mkdtemp(
      `${tmpdir()}${sep}quickord-cashier-server-update`
    );
    const zipPath = `${tempDirPath}${sep}quickord-cashier-server.zip`;

    console.log('Writing zip file');
    await fs.promises.writeFile(zipPath, fileData);

    console.log('Extracting zip file');
    const tempCodePath = `${tempDirPath}${sep}code`;
    await fs.promises.mkdir(tempCodePath);
    const zip = await yauzl.open(zipPath);

    try {
      for await (const entry of zip) {
        if (entry.filename.endsWith(sep)) {
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
    }

    return true;
  } catch (e) {
    console.error(e);
  }

  return false;
}

async function cleanup() {
  console.log('Deleting temp dir');
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
    console.error('Error reading file', e);

    return '';
  }
}

async function updateInitBat() {
  const initBatPath = 'init.bat';
  const tempInitBatPath = `${tempDirPath}${sep}code${sep}init.bat`;

  let currentInitBat: string;
  let newInitBat: string;

  try {
    currentInitBat = await fs.promises.readFile(initBatPath, 'utf-8');
    newInitBat = await fs.promises.readFile(tempInitBatPath, 'utf-8');
  } catch (e) {
    console.error('Error reading init.bat', e);
    return;
  }

  const currentInitBatHash = currentInitBat.replace(/(cd).*/g, '');
  const newInitBatHash = newInitBat.replace(/(cd).*/g, '');

  if (currentInitBatHash !== newInitBatHash) {
    console.log('Updating init.bat');
    try {
      await fs.promises.writeFile(
        initBatPath,
        newInitBat.replace(
          /(cd).*/g,
          currentInitBat.match(/(cd).*/g)?.[0] || ''
        )
      );
    } catch (e) {
      console.error('Error updating init.bat', e);
    }
  }
}

// eslint-disable-next-line import/prefer-default-export
export async function main() {
  try {
    const success = await downloadLatestCode();

    if (success) {
      let currentVersion = '';

      try {
        currentVersion = await fs.promises.readFile('version', 'utf-8');
      } catch (e) {
        console.error('cannot find current version file', e);
      }

      let newVersion = '';

      try {
        newVersion = await fs.promises.readFile(
          `${tempDirPath}${sep}code${sep}version`,
          'utf-8'
        );
      } catch (e) {
        console.error('cannot find new version file', e);
      }

      console.log(
        'Current version:',
        currentVersion,
        ' | New version:',
        newVersion
      );

      if (currentVersion === newVersion && newVersion !== '') {
        console.log('Already up to date');
        return;
      }

      console.log('Updating code to version', newVersion);

      // read all the downloaded files and their md5 hashes
      await readdirRecursive(
        `${tempDirPath}${sep}code`,
        ['init.bat'],
        async (newfile) => {
          const oldFile = newfile.replace(`${tempDirPath}${sep}code${sep}`, '');

          const oldFileHash = await md5File(oldFile);
          const newFileHash = await md5File(newfile);

          if (oldFileHash !== newFileHash) {
            console.log('    Updating file', oldFile);
            await fs.promises.copyFile(newfile, oldFile);
          }
        }
      );

      await updateInitBat();
    } else {
      console.log('Failed to download latest code');
    }
  } finally {
    await cleanup();
  }
}

main();
