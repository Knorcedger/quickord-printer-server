#!/bin/bash

# Run the build command
npm run build:code || { echo "Failed to run npm build:code"; exit 1; }

# Create version file
node ./scripts/create_version_file.js || { echo "Failed to create version file"; exit 1; }

# Remove old builds and prepare new build directory
rm -rf ./builds || { echo "Failed to remove old builds"; exit 1; }
mkdir ./builds || { echo "Failed to create builds directory"; exit 1; }

# Move the dist files to the right directory
mv ./dist/src/* ./dist/ || { echo "Failed to move dist files"; exit 1; }

# Create the zip archive
zip -r ./builds/quickord-cashier-server.zip ./dist config.json package.json package-lock.json init.bat version \
|| { echo "Failed to create zip"; exit 1; }


echo "Build successful"
