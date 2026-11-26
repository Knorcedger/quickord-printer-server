# Printer server for quickord

## Table of Contents

- [Printer server for quickord](#printer-server-for-quickord)
  - [Table of Contents](#table-of-contents)
  - [Introduction](#introduction)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Usage](#usage)
  - [Logs](#logs)
  - [Printer setup](#printer-setup)
  - [Modem Setup](#modem-setup)
  - [How it works](#how-it-works)
  - [Troubleshooting](#troubleshooting)

---

## Introduction

This server long-polls the Quickord backend for print jobs and sends them to local thermal printers. It is intended to be used with the [Quickord](https://app.quickord.com) app. This server was created to be used with thermal printers that support ESC/POS commands. You can configure the local server by going to [this website](https://app.quickord.com/venue/id/printer-settings)

The printer server supports the following OS:

- `windows-x64`

Developers can run it on every operating system,im not sure on building it as exe as i only tested windows for now.

## Installation

Requirements:

just Windows,it is a service now

1. Download the latest release from the [releases page](https://github.com/Knorcedger/quickord-printer-server/releases/latest)
2. Extract navigate to printerServer/builds and run .\printerServerService.exe install on a terminal.It is now installed.
3. You can also just open printerServer.exe if you dont want it as a service.

Requirements for building:

Recommended operating system: Windows as i havent tested on others.

- [Node.js](https://nodejs.org/en/) as of now i use 23.11.0
- [C++ build tools, MSBuild] (https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [python](https://www.python.org/)
- [nasm](https://www.nasm.us/pub/nasm/releasebuilds/2.16rc12/win64/)
- [bash] i dont know why it wont work on other terminals maybe because of zip command?

- NOTE: some node modules are required to be shipped with the exe but you check them in deploy.sh

### Quick Release (code-only zip, any OS)

1. Bump version: `node scripts/create_version_file.js` (increments counter, format: `vYYYY.MM.DD-NNNNNN`)
2. Build: `npm run build` (typechecks, compiles TS, creates `quickord-cashier-server.zip`)
3. Commit and push
4. Create release:
   ```bash
   gh release create <version> ./quickord-cashier-server.zip --title "<version>" --generate-notes --latest
   ```

### Full Build with exe (Windows only)

Run `./deploy.sh` which will:
   - Auto-generate version file
   - Remove and remake builds folders
   - Build the exe via nexe
   - Copy required native node_modules (@serialport, etc.)
   - Create quickord-cashier-server.zip with everything

To do it manually:

1.  npm run build:code
2.  npm run build:bundle
3.  npm run build:exe
4.  put required node_modules in builds folder

To just run:

- npm run start:dev and you will see something like this

````cmd
  ℹ  info      Settings file not found. Creating new settings file.
  ℹ  info      API listening at port 7810
  ```

  [printer setup](#printer-setup)

6.  If the server is running, you can now configure the server by going to [this website](https://app.quickord.com/venue/id/printer-settings)
7.  press search and test them by clicking on the `test` button.
8.  when the test prints something click on the add button.

---

## Configuration

Printer settings live in the backend and are edited on [the printer settings page](https://app.quickord.com/venue/id/printer-settings). The server receives them over the pull channel and caches them in `settings.json`; it uses only the printer addresses (for status checks and keep-alive) and the modems. The documents themselves are formatted by the backend.

`POST /settings` on the LAN is bootstrap-only: it takes the `venueId` and `wsSecret` the settings page sends when pairing a new server. `GET /settings` returns `{ venueId, claimed, settingsHash, version }`. Apart from those, the server serves `GET /` and `GET /status`; every other route returns a JSON 404 (`ROUTE_NOT_FOUND`).

The server configs (in `config.json`) are:

- `CODE_UPDATE_URL`: The URL used in the autoupdate process. This URL points to the latest release of the server on github. (created for every push to the `main` branch)
- `PORT`: The port to use for the server. (default: `7810`)

---

## Usage

1. Launch the server with `npm run start:dev`.
2. Open the [printer settings page](https://app.quickord.com/venue/id/printer-settings) in the Quickord app and pair the server.
3. Prints from the app go to the backend, which queues them as jobs; the server pulls them and prints.

---

## Logs

The server logs are saved in the `app.log` file. The autoupdate logs are saved in the `autoupdate.log` file. These logs are saved in the same folder as the server's `init.bat`. The logs keep the last 3 logs and rotate them. When an issue occurs, you can check the logs to troubleshoot the issue.

The required logs for troubleshooting are:

- `app.log`: This log contains the server logs. You can check this log to see if the server is running correctly.
- `autoupdate.log`: This log contains the autoupdate logs. You can check this log to see if the autoupdate process is working correctly.

Zip all the log files (`app.log`, `app.1.log`, `app.2.log`, `autoupdate.log` ) and send them to the support team for further troubleshooting.

---

## [Printer setup](docs/printer-setup.md)

---

## [Modem Setup](docs/modem.md)

---

## How it works

The server long-polls the backend for its venue's print jobs (`pullClient.ts`), sends each one, already formatted as ESC/POS, to its printer (`printJob.ts`), and reports the result. The same channel carries liveness, check printers / scan network, restart, update and test prints. When the server is not polling, the backend refuses prints with `PS_OFFLINE_NO_FALLBACK`; the app never prints to the server directly. Logs are saved in `app.log`.

The autoupdate process is done by checking the `CODE_UPDATE_URL` for the latest release. If there is a new release, the server will download the latest release and restart itself. The autoupdate process is done on every startup of the server. Autoupdate logs are saved in the `autoupdate.log` file. It keeps the last 3 logs and rotates them.

---

## Troubleshooting

If the server is not working as expected, you can check the logs in the `app.log` and `autoupdate.log` files. These logs are saved in the server folder. The logs keep the last 3 logs and rotate them.

- **The orders are double printing**: Make sure the server is running only once on the venue's machines.
- **The print is scrambled and not Greek**: Check that the codepage matches the encoding you have chosen and is the correct for the specific printer. You can find the codepage in the printer's manual or the self test page.

## Troubleshooting building:

vcbuild.bat error on Windows
install c++ build tools etc on https://visualstudio.microsoft.com/visual-cpp-build-tools/
