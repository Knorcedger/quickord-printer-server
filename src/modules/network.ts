import * as net from 'net';
import * as os from 'os';

function getSubnetFromGateway(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
      }
    }
  }
  return null;
}

const ports = [9100, 515, 631];

// Direct TCP connect timeout per candidate port. A reachable printer answers in
// a few ms; an unused IP either refuses instantly or never answers, so keep this
// short — dead hosts dominate a /24 and each one costs a full timeout.
const SCAN_PORT_TIMEOUT_MS = 1000;

// Open at most this many sockets at once. The whole scan (254 IPs × 3 ports =
// 762 connects) must finish well under the backend's round-trip budget — and
// under Heroku's 30s router cap that fronts the GraphQL request. At 128-wide
// with a 1s timeout the worst case is ~6 waves ≈ 6s.
const SCAN_CONCURRENCY = 128;

async function checkPort(
  ip: string,
  port: number
): Promise<{ ip: string; port: number; open: boolean }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ip, port, open });
    };

    socket.setTimeout(SCAN_PORT_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
    socket.connect(port, ip);
  });
}

// Runs `worker` over `items` with a fixed concurrency cap, preserving order.
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await worker(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runner)
  );
  return results;
}

// Scans the local /24 for open printer ports via direct TCP connects. We skip
// ICMP ping on purpose: probing each host with the `ping` package spawns a
// ping.exe subprocess per IP on Windows (254 at once), which is slow enough to
// exceed the router timeout — and many printers ignore ICMP anyway, so a TCP
// connect to the actual port is both faster and a truer "is it a printer" signal.
export default async function scanNetworkForConnections(): Promise<
  { ip: string; port: number }[]
> {
  const subnet = getSubnetFromGateway();
  if (!subnet) {
    console.warn(
      '⚠️ No active IPv4 network interface found, skipping network scan'
    );
    return [];
  }

  console.log(`🔍 Scanning ${subnet}.0/24 for devices...`);

  const targets: { ip: string; port: number }[] = [];
  for (let i = 1; i < 255; i++) {
    for (const port of ports) {
      targets.push({ ip: `${subnet}.${i}`, port });
    }
  }

  const portResults = await runPool(targets, SCAN_CONCURRENCY, ({ ip, port }) =>
    checkPort(ip, port)
  );

  const printers: { ip: string; port: number }[] = [];
  for (const result of portResults) {
    if (result.open) {
      printers.push({ ip: result.ip, port: result.port });
      console.log(
        `🖨️ Printer (or device) found at ${result.ip}:${result.port}`
      );
    }
  }

  console.log('✅ Finished scanning! Found printers:', printers);
  return printers;
}
