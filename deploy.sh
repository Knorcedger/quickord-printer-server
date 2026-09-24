#!/bin/bash

# Create version file
node ./scripts/create_version_file.js || { echo "Failed to create version file"; exit 1; }

# Check if the version file was created successfully
rm -rf ./dist || { echo "Failed to remove old dist"; exit 1; }
#mkdir ./dist || { echo "Failed to create dist directory"; exit 1; }

# Remove old builds and prepare new build directory
rm -rf ./builds || { echo "Failed to remove old builds"; exit 1; }
mkdir ./builds || { echo "Failed to create builds directory"; exit 1; }

npm run build:code || { echo "Failed to run npm build:code"; exit 1; }
# Run the build command
npm run build:exe || { echo "Failed to run npm build:exe"; exit 1; }

# Create destination directory
mkdir -p ./builds/node_modules


# Copy specific directories from node_modules
cp -r node_modules/@serialport ./builds/node_modules/
cp -r node_modules/debug ./builds/node_modules/
cp -r node_modules/ms ./builds/node_modules/
cp -r node_modules/node-gyp-build ./builds/node_modules/
cp -r node_modules/serialport ./builds/node_modules/
cp -r node_modules/@img ./builds/node_modules/

# Copy package-lock.json (if you meant package-lock.json from the root)

#cp package-lock.json ./builds/node_modules/

cp  version ./builds/builds/  || { echo "Failed to copy version"; exit 1; }
cp  config.json ./builds/builds/ || { echo "Failed to copy config.json"; exit 1; }
cp  printerServerService.exe ./builds/builds/ || { echo "Failed to copy printerServerService.exe"; exit 1; }
# updater.exe is checked in, so copying it blindly ships whatever binary was
# built last - updater-exe/updater.js changes (service config + sc start on the
# manual force-update route) would silently never reach venues. Rebuild it here
# so the shipped binary always matches the source in this commit.
npm run build:updater || { echo "Failed to run npm build:updater"; exit 1; }
cp  updater.exe ./builds/ || { echo "Failed to copy updater.exe"; exit 1; }
cp  printerServerService.xml ./builds/builds/ || { echo "Failed to copy printerServerService.exe"; exit 1; }
cp  start_printer_service.bat ./builds/builds/ || { echo "Failed to copy start_printer_service.bat"; exit 1; }
cp  stop_printer_service.bat ./builds/builds/ || { echo "Failed to copy stop_printer_service.bat"; exit 1; }
cp  uninstall_printer_service.bat ./builds/builds/ || { echo "Failed to copy uninstall_printer_service.bat"; exit 1; }
cp  install_printer_service.bat ./builds/builds/ || { echo "Failed to copy uninstall_printer_service.bat"; exit 1; }
cp  force_autoupdate.bat ./builds/builds/ || { echo "Failed to copy force_autoupdate.bat"; exit 1; }

# Create the zip archive
(cd builds && zip -r ../builds/quickord-cashier-server.zip .) || { echo "Failed to create zip archive"; exit 1; }

# The venue installs this zip by running the printerServer.exe *inside it* as
# the updater, so a zip missing a piece cannot install itself and cannot roll
# back either - it dies in require() and leaves the venue with a stopped
# service. The six cp -r above are unchecked; this is where that gets caught.
for entry in \
  builds/printerServer.exe \
  builds/printerServerService.exe \
  builds/printerServerService.xml \
  builds/config.json \
  builds/version \
  updater.exe \
  node_modules/serialport/package.json \
  node_modules/@serialport/bindings-cpp/package.json \
  node_modules/@img/sharp-win32-x64/package.json \
  node_modules/debug/package.json \
  node_modules/ms/package.json \
  node_modules/node-gyp-build/package.json
do
  unzip -l ./builds/quickord-cashier-server.zip "$entry" > /dev/null 2>&1 \
    || { echo "Release zip is missing $entry - refusing to ship it"; exit 1; }
done

echo "Release zip verified"
echo "Build successful"