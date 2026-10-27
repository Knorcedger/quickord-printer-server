# Quickord Printer Server

## Overview

Node.js/TypeScript Express server (port 7810) that bridges the Quickord restaurant ordering platform with ESC/POS thermal printers. Receives order data via HTTP from the Quickord web app, formats it, and sends it to configured printers via TCP (network) or serial (USB).

### Backend channel

The server talks to the backend over a **single HTTP long-poll pull channel** (`pullClient.ts`): it polls for its venue's pending print jobs, runs each through `printJob.ts`, and reports outcomes back over HTTP. The same channel carries liveness, control ops (check printers / scan network / restart / update), test prints, and version reporting. When the pull channel is down the backend returns `PS_OFFLINE_NO_FALLBACK` and nothing prints; only venues on the backend's `LAN_FALLBACK_VENUE_IDS` get `PS_OFFLINE`, where the frontend falls back to a direct LAN HTTP call to this server's `/print-*` endpoints.

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
│   ├── pullClient.ts           # Long-poll pull loop — sole backend channel (see below)
│   ├── printJob.ts             # Raw ESC/POS job execution (TCP/local), per-printer serialization
│   ├── psIdentity.ts           # venueId/secret/version accessors + restart trigger
│   ├── api.ts                  # Backend GraphQL calls (IP register, error reporting)
│   ├── backendUrl.ts           # Derives the backend HTTP base from QUICKORD_API_URL
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
    └── autoupdate.ts           # GitHub release auto-update after startup
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

It also rebuilds `updater.exe` (`npm run build:updater`, nexe over `updater-exe/updater.js`) before copying it into the release. `updater.exe` is the standalone binary `force_autoupdate.bat` runs; it is checked in, so without that rebuild step a release would ship whatever binary was built last and source changes to `updater-exe/updater.js` would never reach venues. The compiled binary resolves the install directory from `process.execPath` (nexe's `__dirname` points inside the binary's virtual filesystem).

## Windows Service Deployment

On customer machines the server runs as a Windows service via **WinSW**:

- `printerServerService.exe` - WinSW binary (renamed). Wraps `printerServer.exe` as a service named `printerServer`.
- `printerServerService.xml` - WinSW config (id, executable, start mode, dependencies). Read only at `install` time — changes are NOT auto-applied to existing installations.
- Start mode is plain `Automatic` with dependencies on Tcpip/Dnscache/NlaSvc, not delayed: delayed start kept venues without a PS for ~2 min after every reboot. The pull loop and IP registration retry until the network is up.
- `install_printer_service.bat` / `uninstall_printer_service.bat` / `start_printer_service.bat` / `stop_printer_service.bat` - wrappers around `printerServerService.exe install/uninstall/start/stop`.

On a normal boot the release check runs only after `app.listen()` and `initPullClient()`, through `triggerUpdate(undefined, false)`, so the server prints while it checks and downloads. It shares the in-flight guard with the remote `update` command, keeps the failed-release cap (`force = false`), and retries once after 2 min when GitHub was unreachable. The version check is capped at 20s and the download at 10 min (fetch `AbortSignal.timeout`, curl `--connect-timeout`/`--max-time`). Right before the handoff (boot or remote), `pausePullClient()` stops claiming jobs and waits, capped at 45s, for the held poll and every claimed print to finish and report; if the updater cannot start, the loop resumes.

The handoff is the dangerous moment: the updater _is_ the new build, launched as `<staged>/builds/printerServer.exe --update`. A release that cannot start cannot install itself or roll itself back — a zip missing `node_modules` dies in `require('serialport')` before any updater code runs, and the server that agreed to step aside is already gone. So `validateStagedBuild()` checks the staged tree _before_ the handoff, `waitForExeLock()` requires the child to still hold the exe after a settle window rather than merely to have opened it, and `deploy.sh` refuses to ship a zip that is missing any of those pieces.

`builds/failed-release.json` is written by both updaters when an install fails, and counts the attempts for that release tag. The boot-time check writes it too, for the failures that happen before the child exists (a staged build that will not validate or will not start) — passing the tag explicitly, since there is no new build to read a version out of. After `MAX_RELEASE_ATTEMPTS` (3) the boot-time check stops downloading that release, so a rollback cannot loop forever. The `--update` child repeats the check (`overCapRelease()`) before it stops the service, because a rollback restarts an install that may predate the boot-time check; there the loop costs a download instead of a stop-copy-rollback cycle. A newer tag, or any explicit update (remote command, `force_autoupdate.bat`), clears it — an explicit update passes `--force` down to the child so both checks stand aside.

When the `--update` child aborts on the cap it also has to hand the machine back to something that _serves_. An install older than the boot-time check downloads the same release before it listens, so starting it plainly would just feed the loop; the child adds `<arguments>--noupdate</arguments>` to that install's `printerServerService.xml` (WinSW reads it on every start) and, if that edit fails, launches the exe directly with `--noupdate` rather than starting the service. Installs that do read the marker are started normally, so a later release still reaches them on their own — the update check writes `builds/honors-failed-release` to advertise that. The next successful install lays the release's own xml down and undoes the suppression.

To change service config (start mode, dependencies, failure actions) on already-installed machines, either reinstall the service or run `sc.exe config` / `sc.exe failure printerServer ...`. `applyServiceConfig()` in `autoupdate.ts` applies both on every `--update` phase (idempotent) — that is how existing installs get the `<onfailure>` restart policy, since copying a newer xml does not.

## Code Style

- **Never add a `Co-Authored-By:` trailer to commit messages.**
- **Keep comments short.** One or two lines. Explain the non-obvious _why_, not the reasoning that led there. No multi-paragraph rationale blocks above constants or functions.

## Key Patterns

- **Transliteration**: All printed text passes through `tr(text, settings.transliterate)` from `common.ts`. When enabled, converts Greek → Latin characters. Every `printer.println()` / `printer.print()` call with translatable text must use this wrapper.
- **Settings are per-printer**: Each printer in the `settings.json` array has its own configuration (categories, character set, transliterate, etc.)
- **Settings come from the backend**: the database is the source of truth. Each poll echoes `syncedHash`; when it differs, the poll answer carries the full desired settings, applied by `applyDesiredSettings` and cached in `settings.json`.
- **LAN `/settings` is bootstrap-only**: `POST /settings` takes only `venueId` + `wsSecret` (`applyBootstrapIdentity`); printers/modems in the body are ignored. Another venue's push gets 403. `GET /settings` returns only `{ venueId, claimed, settingsHash, version }`.

## Related Repos

- **quickord-fe** (`../quickord-fe`): Frontend app. Printer settings UI is at `apps/app-desktop/pages/venue/[venueId]/printer-settings.tsx` with the configure modal at `apps/app-desktop/components/printerSettings/ConfigureModal.tsx`.
- **quickord-be** (`../quickord-be`): Backend API. Printer settings model at `models/PrinterSettingsModel.ts`.
