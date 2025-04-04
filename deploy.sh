#!/bin/bash

# Create version file
node ./scripts/create_version_file.js || { echo "Failed to create version file"; exit 1; }

# Check if the version file was created successfully
rm -rf ./dist || { echo "Failed to remove old dist"; exit 1; }
mkdir ./dist || { echo "Failed to create dist directory"; exit 1; }

# Remove old builds and prepare new build directory
rm -rf ./builds || { echo "Failed to remove old builds"; exit 1; }
mkdir ./builds || { echo "Failed to create builds directory"; exit 1; }

# Run the build command
npm run build:exe || { echo "Failed to run npm build:exe"; exit 1; }


# Run the updater build command
npm run build:updater || { echo "Failed to run npm build:updater"; exit 1; }

rm ./dist/index.js


# Create the zip archive
zip ./builds/quickord-cashier-server.zip ./dist/* config.json package.json package-lock.json  version || { echo "Failed to create zip"; exit 1; }

echo "Build successful"