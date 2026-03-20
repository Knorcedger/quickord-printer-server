# Quickord Printer Server

## Overview

Node.js/TypeScript Express server (port 7810) that bridges the Quickord restaurant ordering platform with ESC/POS thermal printers. Receives order data via HTTP from the Quickord web app, formats it, and sends it to configured printers via TCP (network) or serial (USB).

## Tech Stack

- **Runtime**: Node.js (v24.8.0)
- **Language**: TypeScript (ES2022)
- **Framework**: Express.js
- **Printer Protocol**: ESC/POS via `node-thermal-printer`
- **Serial Communication**: `serialport` (for USB printers and modem)
- **Validation**: Zod schemas

## Project Structure

```
src/
├── index.ts                    # Entry point - Express server, routes, startup
├── modules/
│   ├── printer.ts              # Core print logic - all print formatting and sending
│   ├── settings.ts             # Zod schemas, settings load/save to settings.json
│   ├── common.ts               # Utilities: transliteration (tr), text formatting, images
│   ├── modem.ts                # Serial modem for phone call routing
│   ├── network.ts              # Network scanner for printer discovery
│   ├── logger.ts               # File logging with rotation
│   ├── translations.ts         # i18n (EN, EL)
│   └── interfaces.ts           # TypeScript interfaces
├── resolvers/
│   ├── printOrders.ts          # POST /print-orders handler + Zod validation
│   ├── settings.ts             # GET/POST /settings handler
│   └── testPrint.ts            # POST /test-print handler
└── autoupdate/
    └── autoupdate.ts           # GitHub release auto-update on startup
```

## Key Files

- `config.json` - Server config (port, update URLs, API URL)
- `settings.json` - Runtime printer configurations (created at first run, not in git)
- `version` - Current version tag, checked by auto-update
- `scripts/build.sh` - Build script that compiles TS and creates release zip
- `scripts/create_version_file.js` - Auto-generates version by incrementing counter
- `scripts/create_release.js` - Creates GitHub release and uploads assets via Octokit (requires `GITHUB_TOKEN`)
- `deploy.sh` - Full release script (Windows only: builds exe, copies native modules, zips everything)

## Build & Release

```bash
# Install dependencies
npm install

# Development
npm run start:dev

# Typecheck
npx tsc -p tsconfig.json --noEmit

# Build & create release zip
npm run build
# This runs: typecheck → compile TS to dist/ → zip dist + config + package files

# Output: quickord-cashier-server.zip (upload this to GitHub release)
```

### Version Format

`vYYYY.MM.DD-NNNNNN` where `NNNNNN` is a sequential counter that increments from the previous version (e.g. `v2026.03.16-019156` → `v2026.03.20-019157`).

### Release Process

1. Bump the version: `node scripts/create_version_file.js`
2. Build: `npm run build`
3. Commit and push
4. Create the GitHub release:
   ```bash
   gh release create v2026.03.20-019157 \
     ./quickord-cashier-server.zip \
     --title "v2026.03.20-019157" \
     --generate-notes \
     --latest
   ```
   Alternatively, use `node scripts/create_release.js` with `GITHUB_TOKEN` and `TAG` env vars set (this also uploads `requirements.zip` for the exe build).
5. Venue printer servers auto-update on next startup

### Full Windows Build (exe)

Run `deploy.sh` on Windows. This builds the exe via nexe, copies native node_modules (@serialport, etc.), and creates the full zip with service files. Requires C++ build tools, Python, and nasm.

## Key Patterns

- **Transliteration**: All printed text passes through `tr(text, settings.transliterate)` from `common.ts`. When enabled, converts Greek → Latin characters. Every `printer.println()` / `printer.print()` call with translatable text must use this wrapper.
- **Settings are per-printer**: Each printer in the `settings.json` array has its own configuration (categories, character set, transliterate, etc.)
- **Settings are saved in two places**: locally in `settings.json` AND in the Quickord database via the frontend's GraphQL mutation. The frontend's `syncPrinterSettings` feature pushes DB settings → local server on page load.

## Related Repos

- **quickord-fe** (`../quickord-fe`): Frontend app. Printer settings UI is at `apps/app-desktop/pages/venue/[venueId]/printer-settings.tsx` with the configure modal at `apps/app-desktop/components/printerSettings/ConfigureModal.tsx`.
- **quickord-be** (`../quickord-be`): Backend API. Printer settings model at `models/PrinterSettingsModel.ts`.
