# !/bin/bash
npm run build:code

rm -rf test

mkdir test
zip -r test/quickord-cashier-server.zip dist/src/ config.json package.json package-lock.json init.bat version

#zip -r ./builds/requirements.zip ./binaries/
