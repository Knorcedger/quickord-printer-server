import { promises as fs } from 'fs';

async function readDir(dir) {
  const files = await fs.readdir(dir, { withFileTypes: true });
  for (const file of files) {
    if (file.isDirectory()) {
      await readDir(`${dir}/${file.name}`);
    } else {
      if (file.name.endsWith('.js')) {
        console.log(`updating file: ${dir}/${file.name}`);

        // read the file
        const data = await fs.readFile(`${dir}/${file.name}`, 'utf8');

        // replace all instances of .ts with .js
        const newData = data.replace(/.ts"/g, '.js"');

        // write the file
        await fs.writeFile(`${dir}/${file.name}`, newData, 'utf8');
      }
    }
  }
}

async function main() {
  // recursively read all files in the ./dist directory
  await readDir('./dist');
}

main();
