# !/bin/bash
npm run build:code

rm -rf builds

mkdir builds
zip -r ./builds/quickord-cashier-server.zip ./dist/ ./config.json ./package.json ./package-lock.json ./init.bat ./version
zip -r ./builds/requirements.zip ./binaries/
