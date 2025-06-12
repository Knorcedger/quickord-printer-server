# !/bin/bash
npm run build:code

rm -rf builds

mkdir builds
zip -r ./quickord-cashier-server.zip ./dist ./config.json ./package.json ./package-lock.json ./init.bat ./version
#zip -r ./builds/requirements.zip ./binaries/
