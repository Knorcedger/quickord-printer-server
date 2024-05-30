/* eslint-disable no-underscore-dangle */
import fs from 'node:fs/promises';
import process from 'node:process';
import signale from 'signale';

let _filename = 'app';

const appendLog = async (...args: unknown[]) => {
  await fs.appendFile(
    `${_filename}.log`,
    `${new Date().toISOString()} ${args
      .map((arg) => {
        let out = '';

        if (arg instanceof Error) {
          out = `${arg.name}: ${arg.message}${arg.cause ? ` (cause: ${arg.cause})` : ''}\n${arg.stack}`;
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

export default {
  error,
  info,
  init,
  warn,
};
