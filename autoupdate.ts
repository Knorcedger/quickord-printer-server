import fs from 'fs';

async function main() {
  const a = await fetch(
    'https://github.com/Knorcedger/quickord-printer-server/releases/latest/download/quickord-cashier-server.zip'
  );

  const b = Buffer.from(await (await a.blob()).arrayBuffer());

  fs.writeFileSync('quickord-cashier-server.zip', b);
}
main();
