import fs from 'fs';
import signale from 'signale';

const appendLog = (...args: unknown[]) => {
  fs.appendFileSync(
    'app.log',
    `${args
      .map((arg) => {
        return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
      })
      .join(' ')}\n`
  );
};

const info = (...args: unknown[]) => {
  appendLog(args);
  signale.info(...args);
};
const error = (...args: unknown[]) => {
  appendLog(args);
  signale.error(...args);
};
const warn = (...args: unknown[]) => {
  appendLog(args);
  signale.warn(...args);
};
const init = () => {
  const logs = fs.readdirSync('./').filter((file) => file.endsWith('.log'));

  if (logs[0]) {
    const log1 = fs.readFileSync('./app.log', 'utf8');
    fs.writeFileSync('app.1.log', log1);

    if (logs[1]) {
      const log2 = fs.readFileSync('./app.1.log', 'utf8');
      fs.writeFileSync('app.2.log', log2);
    }
  }

  fs.writeFileSync(
    'app.log',
    `Log file created at ${new Date()}. OS: ${process.platform}\n`
  );
};

export default {
  error,
  info,
  init,
  warn,
};
