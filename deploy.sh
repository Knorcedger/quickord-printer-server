#!/bin/bash
if [ -n "$OS" ] && [[ "$OS" == *"Windows"* ]]; then
  cmd.exe /C '"C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64'
fi
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

# Copy package-lock.json (if you meant package-lock.json from the root)

#cp package-lock.json ./builds/node_modules/

cp  version ./builds/builds/  || { echo "Failed to copy version"; exit 1; }
cp  config.json ./builds/builds/ || { echo "Failed to copy config.json"; exit 1; }
cp  printerServerService.exe ./builds/builds/ || { echo "Failed to copy printerServerService.exe"; exit 1; }
cp  printerServerService.xml ./builds/builds/ || { echo "Failed to copy printerServerService.exe"; exit 1; }
cp  start_printer_service.bat ./builds/builds/ || { echo "Failed to copy start_printer_service.bat"; exit 1; }
cp  stop_printer_service.bat ./builds/builds/ || { echo "Failed to copy stop_printer_service.bat"; exit 1; }
cp  uninstall_printer_service.bat ./builds/builds/ || { echo "Failed to copy uninstall_printer_service.bat"; exit 1; }
cp  install_printer_service.bat ./builds/builds/ || { echo "Failed to copy uninstall_printer_service.bat"; exit 1; }

# Run the updater build command
#npm run build:updater || { echo "Failed to run npm build:updater"; exit 1; }

#rm ./dist/index.js


# Create the zip archive
(cd builds && zip -r ../builds/quickord-cashier-server.zip .) || { echo "Failed to create zip archive"; exit 1; }
cd ..

echo "Build successful"