/* eslint-disable no-underscore-dangle */
import AdmZip from 'adm-zip';

import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';

import process from 'node:process';

import signale from 'signale';

let _filename = 'app';

// Interface for logger instance
export interface Logger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  init: (filename?: string) => Promise<void>;
}

// Factory function to create a logger with specific filename
const createLoggerInstance = (defaultFilename: string = 'app'): Logger => {
  let filename = defaultFilename;

  const appendLog = async (...args: unknown[]) => {
    await fs.appendFile(
      `${filename}.log`,
      `${new Date().toISOString()} ${args
        .map((arg) => {
          let out = '';

          if (arg instanceof Error) {
            const errorWithCause = arg as { cause?: unknown }; // Type assertion to include cause
            out = `${arg.name}: ${arg.message}${errorWithCause.cause ? ` (cause: ${errorWithCause.cause})` : ''}\n${arg.stack}`;
          } else if (typeof arg === 'object') {
            out = JSON.stringify(arg);
          } else {
            out = String(arg);
          }

          return out;
        })
        .join(' ')}\n`
    );
  };

  const info = (...args: unknown[]) => {
    appendLog(...args);
    signale.info(...args);
  };

  const error = (...args: unknown[]) => {
    appendLog(...args);
    signale.error(...args);
  };

  const warn = (...args: unknown[]) => {
    appendLog(...args);
    signale.warn(...args);
  };

  const init = async (newFilename: string = defaultFilename) => {
    filename = newFilename;

    const logs = (await fs.readdir('./')).filter(
      (file) => file.endsWith('.log') && file.startsWith(filename)
    );

    if (logs[0]) {
      if (logs[1]) {
        const log2 = await fs.readFile(`./${filename}.1.log`, 'utf8');
        await fs.writeFile(`${filename}.2.log`, log2);
      }

      const log1 = await fs.readFile(`./${filename}.log`, 'utf8');
      await fs.writeFile(`${filename}.1.log`, log1);
    }

    await fs.writeFile(
      `${filename}.log`,
      `${new Date().toISOString()} Log file created at ${new Date()}. OS: ${process.platform}\n`
    );
  };

  return {
    info,
    error,
    warn,
    init,
  };
};

// Legacy appendLog for backward compatibility with _filename
const appendLog = async (...args: unknown[]) => {
  await fs.appendFile(
    `${_filename}.log`,
    `${new Date().toISOString()} ${args
      .map((arg) => {
        let out = '';

        if (arg instanceof Error) {
          const errorWithCause = arg as { cause?: unknown }; // Type assertion to include cause
          out = `${arg.name}: ${arg.message}${errorWithCause.cause ? ` (cause: ${errorWithCause.cause})` : ''}\n${arg.stack}`;
        } else if (typeof arg === 'object') {
          out = JSON.stringify(arg);
        } else {
          out = String(arg);
        }

        return out;
      })
      .join(' ')}\n`
  );
};

const info = (...args: unknown[]) => {
  appendLog(...args);
  signale.info(...args);
};
const error = (...args: unknown[]) => {
  appendLog(...args);
  signale.error(...args);
};
const warn = (...args: unknown[]) => {
  appendLog(...args);
  signale.warn(...args);
};
const init = async (filename: string = 'app') => {
  _filename = filename;

  const logs = (await fs.readdir('./')).filter(
    (file) => file.endsWith('.log') && file.startsWith(filename)
  );

  if (logs[0]) {
    if (logs[1]) {
      const log2 = await fs.readFile(`./${filename}.1.log`, 'utf8');
      await fs.writeFile(`${filename}.2.log`, log2);
    }

    const log1 = await fs.readFile(`./${filename}.log`, 'utf8');
    await fs.writeFile(`${filename}.1.log`, log1);
  }

  await fs.writeFile(
    `${filename}.log`,
    `${new Date().toISOString()} Log file created at ${new Date()}. OS: ${process.platform}\n`
  );
};

const createZip = () => {
  const zip = new AdmZip();

  // Dynamically find all log files in the current directory
  const allFiles = readdirSync('./');
  const logFiles = allFiles.filter((file) => file.endsWith('.log'));

  logFiles.forEach((f) => {
    if (existsSync(`./${f}`)) {
      zip.addLocalFile(`./${f}`);
    }
  });

  return zip.toBuffer();
};

// Create a logger instance for a specific file/printer
export const createLogger = (filename: string): Logger => {
  return createLoggerInstance(filename);
};

export default {
  createZip,
  error,
  info,
  init,
  warn,
};
