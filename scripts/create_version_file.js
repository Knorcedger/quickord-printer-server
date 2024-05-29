import fs from 'fs';

const now = new Date();
const version = `v${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}-${now.getTime().toString().slice(-5)}`;

fs.writeFileSync('version', version.trim());
