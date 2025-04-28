/* eslint-disable no-continue */
/* eslint-disable default-param-last */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */

import * as fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as JSZip from 'jszip';
import { readFile } from 'node:fs/promises';

import * as nconf from 'nconf';

nconf.argv().env().file('./config.json');

import { exit } from 'node:process';
let path2 = '';
let args = ['--update', 'test'];
let destDir = '../';
/*
    tempDirPath = await fs.promises.mkdtemp(
      `${tmpdir()}${sep}quickord-cashier-server-update`
    );*/

const ZIPPATH = '../quickord-cashier-server.zip';
const tempDirPath = `${tmpdir()}${sep}quickord-cashier-server-update`;
let srcDir = '';

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
async function copyOnlyFiles() {
  console.log(`Copying files from ${srcDir} to ${destDir}`);

  async function walk(currentDir) {
    let entries;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      console.error(`Error reading directory ${currentDir}:`, err);
      return;
    }

    for (const entry of entries) {
      const fullSrcPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(srcDir, fullSrcPath);
      const destPath = path.join(destDir, relativePath);

      try {
        if (entry.isDirectory()) {
          await fsp.mkdir(destPath, { recursive: true });
          await walk(fullSrcPath);
        } else if (entry.isFile()) {
          await fsp.copyFile(fullSrcPath, destPath);
          console.log(`Copied ${relativePath}`);
        }
      } catch (err) {
        console.error(`Error processing ${fullSrcPath}:`, err);
      }
    }
  }

  try {
    await walk(srcDir);
    console.log('✅ Copy completed.');
  } catch (err) {
    console.error('❌ Failed to copy files:', err);
  }
}

async function downloadLatestCode() {
  console.log('you can start');

  const cwd = process.cwd();
  const parentDir = path.resolve(cwd, '..');

  console.log(`Parent directory: ${parentDir}`);

  try {
    // logger.info('Downloading latest code');
    //  const res = await fetch(nconf.get('CODE_UPDATE_URL'));

    // const res = await fetch(nconf.get('CODE_UPDATE_URL'));
    const fileData = await readFile(ZIPPATH); //Buffer.from(await (await res.blob()).arrayBuffer());

    //logger.info('Creating temp dir');
    srcDir = await fs.promises.mkdtemp(
      tempDirPath
      // `${tmpdir()}${sep}quickord-cashier-server-update`
    );
    //
    const zipPath = `${srcDir}${sep}quickord-cashier-server.zip`;
    //   //logger.info('Writing zip file');
    await fs.promises.writeFile(zipPath, fileData);
    //
    //  // logger.info('Extracting zip file');
    const tempCodePath = `${srcDir}${sep}code`;
    await fs.promises.mkdir(tempCodePath);
    //
    //
    const zipBuffer = await fsp.readFile(zipPath);
    await extractZip(zipBuffer, tempCodePath);
    const updateArg = tempCodePath;
    console.log(updateArg);
    args[1] = tempCodePath;
    args[2] = '--parent';
    args[3] = parentDir;
    path2 = tempCodePath + '/builds/printerServer.exe';
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', path2, ...args], {
        detached: true,
        stdio: 'ignore', // use 'inherit' for debugging if needed
      });

      child.on('error', (err) => {
        console.error('Failed to spawn process:', err);
      });

      child.unref(); // Important for detached mode

      console.log('Spawned successfully, exiting current app.');
      process.exit();
    } catch (err) {
      console.error('Exception during spawn:', err);
    }

    return true;
  } catch (e) {
    console.log(e);
    //  logger.error(e);
  }

  return false;
}

async function cleanup(dir) {
  console.log(`Cleaning up: ${dir}`);
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await cleanup(fullPath);
    } else {
      await fsp.unlink(fullPath);
    }
  }

  await fsp.rmdir(dir); // <-- this must be dir, NOT srcDir
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function autoUpdate(path: string[]) {
  console.log('AutoUpdate path:', path);
  if (path.length === 0) {
    await downloadLatestCode();
  } else if (path[0] === '--update') {
    srcDir = path[1]?.toString() || '';
    destDir = path[3]?.toString() || '';
    console.log(`srcDir: ${srcDir}`);
    console.log(`destDir: ${destDir}`);
    await copyOnlyFiles();
    path[0] = '--remove';
    path2 = path[3] + '/builds/printerServer.exe' || '';

    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', path2, ...path], {
        detached: true,
        stdio: 'ignore', // use 'inherit' for debugging if needed
      });

      child.on('error', (err) => {
        console.error('Failed to spawn process:', err);
      });

      child.unref(); // Important for detached mode

      console.log('Spawned successfully, exiting current app.');
      process.exit();
    } catch (err) {
      console.error('Exception during spawn:', err);
    }
    //
  } else if (path[0] === '--remove') {
    srcDir = path[1]?.toString() || '';
    console.log(`srcDir: ${srcDir}`);
    await cleanup(srcDir);
  }
}
