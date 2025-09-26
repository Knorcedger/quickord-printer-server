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
import { spawn, exec } from 'node:child_process';
import * as https from 'node:https';
import * as path from 'node:path';
import JSZip from 'jszip';

import nconf from 'nconf';

nconf.argv().env().file({ file: './config.json' });
let path2 = '';
let args = ['--update', 'test'];
let destDir = '../';

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

export async function copyOnlyFiles(
  srcDir: string,
  destDir: string,
  options: {
    ignoreFolders?: string[];
    skipNestedNodeModules?: boolean;
  } = {}
): Promise<void> {
  const { ignoreFolders = ['snapshot'], skipNestedNodeModules = true } =
    options;
  const ignored = new Set(ignoreFolders);

  await fs.promises.rm(destDir, { recursive: true, force: true });
  await fs.promises.mkdir(destDir, { recursive: true });

  function isNestedBuildsPath(filepath: string): boolean {
    const relativePath = path.relative(srcDir, filepath);
    const segments = relativePath.split(path.sep);
    return segments.filter((seg) => seg === 'builds').length > 1;
  }

  async function walk(currentDir: string) {
    const entries = await fs.promises.readdir(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const entrySrcPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(srcDir, entrySrcPath);
      const entryDestPath = path.join(destDir, relativePath);

      // Skip explicitly ignored folders
      if (entry.isDirectory() && ignored.has(entry.name)) {
        console.log(`🚫 Ignoring folder: ${relativePath}`);
        continue;
      }

      // Skip deeply nested node_modules inside builds
      if (
        skipNestedNodeModules &&
        entry.isDirectory() &&
        entry.name === 'node_modules' &&
        isNestedBuildsPath(entrySrcPath)
      ) {
        console.log(`🚫 Skipping nested node_modules: ${relativePath}`);
        continue;
      }

      if (entry.isDirectory()) {
        await fs.promises.mkdir(entryDestPath, { recursive: true });
        await walk(entrySrcPath);
      } else if (entry.isFile()) {
        await fs.promises.copyFile(entrySrcPath, entryDestPath);
        console.log(`✅ Copied: ${relativePath}`);
      }
    }
  }

  await walk(srcDir);
  console.log('🎉 Copy completed.');
}
export async function relaunchExe(appPath: string, args: string[]) {
  const exePath = path.resolve(appPath); // Ensure absolute path

  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', appPath, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    child.unref();

    console.log('Relaunched exe with args. Waiting to exit...');

    setTimeout(async () => {
      process.exit(0);
    }, 500);
    //}, 500); // 500ms delay to ensure safe spawn
  } catch (err) {
    console.error('Failed to relaunch exe:', err);
  }
}
export async function deleteFolderRecursive(
  folderPath: string,
  silent: boolean = false
): Promise<void> {
  try {
    const entries = await fsp.readdir(folderPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name);

      if (entry.isDirectory()) {
        await deleteFolderRecursive(fullPath, silent); // recursive for subfolders
      } else {
        await fsp.unlink(fullPath); // delete file
      }
    }

    await fsp.rmdir(folderPath); // remove empty folder
    if (!silent) {
      console.log(`Deleted: ${folderPath}`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      if (!silent) {
        console.warn(`Folder does not exist: ${folderPath}`);
      }
    } else {
      if (!silent) {
        console.error(`Error deleting ${folderPath}:`, err.message || err);
      }
    }
  }
}
function isLatestVersion(current: string, latest: string): boolean {
  // Remove leading 'v'
  const curr = current.startsWith('v') ? current.slice(1) : current;
  const lat = latest.startsWith('v') ? latest.slice(1) : latest;
  return curr >= lat; // simple lexicographic comparison works here
}

export async function downloadLatestCode(): Promise<string | null> {
  const url = nconf.get('CODE_UPDATE_URL');
  console.log('Starting download from:', url);
  console.log('from url:', url);

  const srcDir = await fsp.mkdtemp(tempDirPath);
  const zipPath = path.resolve(srcDir, 'quickord-cashier-server.zip');

  // Download via curl
  await new Promise<void>((resolvePromise, reject) => {
    const cmd = `curl -L "${url}" -o "${zipPath}"`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(err);
      console.log(stdout || stderr);
      resolvePromise();
    });
  });

  // Extract zip
  const tempCodePath = path.resolve(srcDir, 'code');
  await fsp.mkdir(tempCodePath, { recursive: true });
  const zipBuffer = await fsp.readFile(zipPath);
  await extractZip(zipBuffer, tempCodePath);

  // Read versions
  let currentVersion = '';
  try {
    currentVersion = (await fsp.readFile('version', 'utf-8')).trim();
    console.log('Current version:', currentVersion);
  } catch {
    console.log('No current version file found, assuming update needed.');
  }

  let latestVersion = '';
  try {
    latestVersion = (
      await fsp.readFile(
        path.resolve(tempCodePath, 'builds', 'version'),
        'utf-8'
      )
    ).trim();
    console.log('Latest version:', latestVersion);
  } catch {
    try {
      // fallback if version is in root of zip
      latestVersion = (
        await fsp.readFile(path.resolve(tempCodePath, 'version'), 'utf-8')
      ).trim();
      console.log('Latest version (root):', latestVersion);
    } catch (e) {
      console.error('Cannot find latest version file. Proceeding with update.');
    }
  }

  if (latestVersion && isLatestVersion(currentVersion, latestVersion)) {
    console.log('Already up to date. Cleaning up temp folder.');
    await deleteFolderRecursive(srcDir, true);
    return null; // no update needed
  }
  console.log('Update needed. Code ready at:', tempCodePath);
  console.log('Updating to latest version');
  console.log(tempCodePath);
  const cwd = process.cwd();
  const parentDir = path.resolve(cwd, '..');

  args[1] = tempCodePath;
  args[2] = '--parent';
  args[3] = parentDir;
  path2 = tempCodePath + '/builds/printerServer.exe';
  relaunchExe(path2, args);
  return tempCodePath;
}

export async function safeCleanup(dirPath: string) {
  try {
    const resolvedPath = path.resolve(dirPath);
    const stat = await fsp.stat(resolvedPath).catch(() => null);
    if (!stat) return; // folder doesn't exist

    // Tiny delay to ensure all streams are closed
    await new Promise((res) => setTimeout(res, 50));

    await fsp.rm(resolvedPath, { recursive: true, force: true });
    console.log('✅ Temp folder cleaned up:', resolvedPath);
  } catch (err: any) {
    console.error('⚠️ Failed to clean temp folder:', err.message);
  }
}

export async function copyRecursive(
  sourceFolder: string,
  destFolder: string
): Promise<void> {
  if (!fs.existsSync(sourceFolder)) {
    throw new Error(`Source folder does not exist: ${sourceFolder}`);
  }

  if (!fs.existsSync(destFolder)) {
    fs.mkdirSync(destFolder, { recursive: true });
  }

  const entries = fs.readdirSync(sourceFolder, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceFolder, entry.name);
    const destPath = path.join(destFolder, entry.name);

    if (entry.isDirectory()) {
      await copyRecursive(sourcePath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
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

export function copyWithCmd(
  sourceFolder: string,
  destFolder: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const src = path.resolve(sourceFolder);
    const dest = path.resolve(destFolder);

    const command = `xcopy "${src}" "${dest}" /E /I /Y`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${stderr}`);
        return reject(error);
      }
      console.log(stdout);
      resolve(undefined);
    });
  });
}

function copySettingsFile(settingsPath, destDir) {
  return new Promise((resolve, reject) => {
    const command = `xcopy "${settingsPath}" "${path.join(destDir, 'builds')}\\" /Y`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error copying settings: ${stderr}`);
        return reject(error);
      }
      console.log('Settings file copied with xcopy.');
      resolve(undefined);
    });
  });
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
    console.log(process.cwd());
    process.chdir(srcDir + '\\builds');
    console.log(process.cwd());
    try {
      await copySettingsFile(
        'C:\\Users\\Xristoskrik\\Documents\\projects\\printer2\\quickord-printer-server\\builds\\builds\\settings.json',
        `${srcDir}`
      );
      await deleteFolderRecursive(destDir);
    } catch (err: any) {
      console.error('cleanupMain failed:', err.message || err);
    }

    console.log(process.cwd());
    try {
      await fsp.mkdir(destDir, { recursive: true });
      console.log(`Created folder: ${destDir}`);
    } catch (err: any) {
      console.error(
        `Failed to create folder "${destDir}":`,
        err.message || err
      );
    }
    console.log('paths: ', srcDir, destDir);

    await copyWithCmd(srcDir, destDir);
    // await deleteFolderRecursive(`${destDir}${sep}builds${sep}node_modules`);
    path[0] = '--remove';
    path2 = `${path[3]}${sep}builds${sep}printerServer.exe` || '';
    console.log(path2);
    console.log(srcDir, destDir);
    const buildsDir = destDir + '\\builds';
    try {
      // Change directory to the 'builds' folder inside destDir
      process.chdir(buildsDir);
      console.log(`Successfully changed directory to ${buildsDir}`);
    } catch (err) {
      console.log(`Failed to change directory: ${err.message}`);
    }
    relaunchExe(path2, path);
    //
  } else if (path[0] === '--remove') {
    let srcDir = path[1]?.toString() || '';
    console.log(`srcDir: ${srcDir}`);

    const currentDir = process.cwd();
    const parentDir = dirname(srcDir);
    console.log(parentDir);
    await deleteFolderRecursive(parentDir);
  }
}
