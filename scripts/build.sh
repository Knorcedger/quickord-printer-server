# !/bin/bash
npm run build
npm run deno:compile:windows

zip -r build.zip ./dist/ ./config.json
