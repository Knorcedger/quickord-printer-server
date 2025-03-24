const net = require("net");
const ping = require("ping");

const subnet = "192.168.1";
const ports = [9100, 515, 631];

async function checkPort(ip: string, port: number): Promise<{ ip: string; port: number; open: boolean }> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2000);

        socket.connect(port, ip, () => {
            socket.destroy();
            resolve({ ip, port, open: true });
        });

        socket.on("error", () => {
            socket.destroy();
            resolve({ ip, port, open: false });
        });

        socket.on("timeout", () => {
            socket.destroy();
            resolve({ ip, port, open: false });
        });
    });
}

export default async function scanNetworkForConnections(): Promise<{ ip: string; port: number }[]> {
    console.log(`🔍 Scanning ${subnet}.0/24 for devices...`);

    const printers: { id :string,ip: string; port: number }[] = [];
    const pingPromises: Promise<any>[] = [];

    // Step 1: Ping all IPs in the subnet
    for (let i = 1; i < 255; i++) {
        let ip = `${subnet}.${i}`;
        pingPromises.push(ping.promise.probe(ip, { timeout: 1 }));
    }

    const pingResults = await Promise.all(pingPromises);
    const aliveHosts = pingResults.filter((res) => res.alive).map((res) => res.host);

    // Step 2: Check ports on alive hosts
    const portCheckPromises: Promise<{ ip: string; port: number; open: boolean }>[] = [];
    for (const ip of aliveHosts) {
        for (const port of ports) {
            portCheckPromises.push(checkPort(ip, port));
        }
    }

    const portResults = await Promise.all(portCheckPromises);

    // Step 3: Filter and collect open ports
    for (const result of portResults) {
        if (result.open) {
            printers.push({ id: result.ip,ip: result.ip, port: result.port });
            console.log(`🖨️ Printer (or device) found at ${result.ip}:${result.port}`);
        }
    }

    console.log("✅ Finished scanning! Found printers:", printers);
    return printers;
}
