# !/bin/bash
rm -rf dist
rm -rf builds

npx swc ./src/ -d ./dist/

node ./scripts/update_imports.js

mkdir builds
zip -r ./builds/quickord-cashier-server.zip ./dist/ ./config.json ./package.json ./package-lock.json ./init.bat ./binaries/
