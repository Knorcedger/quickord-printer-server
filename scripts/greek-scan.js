// Greek codepage scanner for Aclas PP7X (and similar ESC/POS printers)
// Node.js version - no PowerShell needed. Sends raw bytes to the printer over TCP 9100.
//
// Usage:
//   node scripts/greek-scan.js                 (uses default IP below)
//   node scripts/greek-scan.js 192.168.88.5    (pass a different IP)
//   node scripts/greek-scan.js 192.168.88.5 255   (also raise MaxN if 63 finds nothing)
//
// Read the printed receipt: find the line where the Greek sample (ΑΒΓΔΕ αβγδε)
// prints CORRECTLY. The number on that line is the value to use.
//   - "t=NN" lines  -> use that NN as the `codePage` (ESC t n) value
//   - the section header tells you which `characterSet` (encoding) matches

import net from 'net';
import iconv from 'iconv-lite'; // ships with node-thermal-printer

const IP = process.argv[2] || '192.168.1.130';
const PORT = 9100;
const MAX_N = Number.isInteger(parseInt(process.argv[3], 10))
  ? parseInt(process.argv[3], 10)
  : 63;

const ESC = 0x1b,
  GS = 0x1d,
  LF = 0x0a;

// Greek sample: uppercase + lowercase + final sigma + a couple of accents + euro
const sample = 'ΑΒΓΔΕ αβγδες ά έ €';

// iconv-lite encoding names mapped to the codepage label printed on the receipt.
const encodings = [
  { label: 737, name: 'cp737' }, // DOS Greek
  { label: 869, name: 'cp869' }, // DOS Greek alt
  { label: 1253, name: 'win1253' }, // Windows-1253
  { label: 28597, name: 'iso-8859-7' },
];

const chunks = [];
const push = (b) => chunks.push(Buffer.from(b));
const ascii = (s) => push(Buffer.from(s, 'ascii'));
const enc = (name, s) => push(iconv.encode(s, name));
const init = () => push([ESC, 0x40]); // ESC @  -> reset to default
const setPage = (n) => push([ESC, 0x74, n]); // ESC t n -> select code page n
const nl = () => push([LF]);

init();
ascii('=== GREEK CODEPAGE SCAN ===');
nl();
ascii('find the line with correct Greek');
nl();
nl();

// --- Section 1: default page (no ESC t) ---
ascii('-- DEFAULT PAGE (no ESC t) --');
nl();
for (const { label, name } of encodings) {
  init();
  ascii('def enc=' + label + ': ');
  enc(name, sample);
  nl();
}
nl();

// --- Section 2: scan ESC t n for each candidate encoding ---
for (const { label, name } of encodings) {
  ascii('-- ESC t n, enc=' + label + ' --');
  nl();
  for (let n = 0; n <= MAX_N; n++) {
    setPage(n);
    ascii('t=' + n + ' : ');
    enc(name, sample);
    nl();
  }
  nl();
}

// feed + cut
push([LF, LF, LF, LF]);
init();
push([GS, 0x56, 0x00]); // GS V 0 -> full cut

const payload = Buffer.concat(chunks);

console.log(`Connecting to ${IP}:${PORT} (MaxN=${MAX_N}) ...`);
const client = net.connect(PORT, IP, () => {
  client.write(payload, () => {
    setTimeout(() => {
      client.end();
      console.log('Done. Read the receipt and report the matching line.');
    }, 300);
  });
});
client.on('error', (e) => console.error('Connection error:', e.message));
