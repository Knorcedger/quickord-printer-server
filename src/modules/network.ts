const net = require("net");
const ping = require("ping");

// Replace with your subnet (e.g., 192.168.1.x)
const subnet = "192.168.1";
const ports = [9100, 515, 631]; // List of ports to check

function checkPort(ip, port, callback) {
    const socket = new net.Socket();

    socket.setTimeout(2000);
    socket.connect(port, ip, () => {
        console.log(`✅ Port ${port} is open on ${ip}`);
        socket.destroy();
        callback(ip, port, true);
    });

    socket.on("error", () => {
        socket.destroy();
        callback(ip, port, false);
    });

    socket.on("timeout", () => {
        socket.destroy();
        callback(ip, port, false);
    });
}

export default async function scanNetworkForConnections() {
    console.log(`🔍 Scanning ${subnet}.0/24 for devices...`);
    
    for (let i = 1; i < 255; i++) {
        let ip = `${subnet}.${i}`;

        ping.promise.probe(ip, { timeout: 1 })
            .then((res) => {
                if (res.alive) {
                    // console.log(`🎯 Found device: ${ip}`);
                    
                    ports.forEach((port) => {
                        checkPort(ip, port, (host, port, isOpen) => {
                            if (isOpen) {
                                console.log(`🖨️ Printer (or device) found at ${host}:${port}`);
                            }
                        });
                    });
                }
            });
    }
}
