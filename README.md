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

This is a simple server that listens for print requests and sends them to a printer. It is intended to be used with the [Quickord](https://app.quickord.com) app. This server was created to be used with thermal printers that support ESC/POS commands. You can configure the local server by going to [this website](https://app.quickord.com/venue/id/printer-settings)

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

1. It is recommended to run ./deploy.sh and everything will become automated, it will

   - update version file
   - remove and remake builds folders and it will contain:
     - quickord-cashier-server.zip where you can just open a new release and ship the new version
     - node_modules / builds and you can run the printerServer.exe

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

The following are the printer settings that can be configured:

- `categoriesToPrint: Array<string>`: The categories (`_ids`) that should be printed.
- `documentsToPrint: Array<string>` : Can contain "ALP","ORDER","PAYMENT-SLIP","ORDERFORM" which is what documents a printer is going to print
- `orderMethodsToPrint: Array<string>`: what orderMethods a printer is going to print. Can contain
"DELIVERY","DINE_IN","TAKE_AWAY_INSIDE","TAKE_AWAY_PACKAGE","EFOOD","WOLT","FAGI","BOX"
- `characterSet: CharacterSetEnum`: The character set to use for the printer. This is taken from the `node-thermal-printer` package.
- `codePage: number`: The code page to use for the printer. This is used in conjunction with `characterSet` to setup the encoding for the printing. This can be found in the printer's manual or the selft test page.
- `copies: number`: The number of copies to print.
- `name: string`: The friendly name of the printer.
- `networkName: string`: The network name of the printer.
- `ip: string`: The IP address of the printer. (instead of port)
- `port: string`: The port to use for the printer. (instead of IP)
- `textOptions: Array<'BOLD_PRODUCTS' | 'BOLD_ORDER_NUMBER'>`: The text options to use for the printer. This is used to change the text depending on the specified options.
- `textSize: 'NORMAL' | 'ONE' | 'TWO' | 'THREE'`: The size of the text to print.

The printers are configured by sending a POST to `/settings` with the following body (example):

```json
[
{
  "categoriesToPrint": ['idone','idtwo'...],
  "documentsToPrint": [
      "ALP",
      "ORDER",
      "PAYMENT-SLIP",
      "ORDERFORM"
    ],
  "orderMethodsToPrint": [
      "DELIVERY",
      "DINE_IN",
      "TAKE_AWAY_INSIDE",
      "TAKE_AWAY_PACKAGE",
      "EFOOD",
      "WOLT",
      "FAGI",
      "BOX"
    ],
  "characterSet": "WPC1253_GREEK",
  "codePage": 90,
  "copies": 1,
  "ip": "192.168.178.150",
  "name": "",
  "networkName": "thermalprinternetum.fritz.box",
  "port": "",
  "textOptions": [],
  "textSize": "NORMAL"
}
]
````

The server configs (in `config.json`) are:

- `CODE_UPDATE_URL`: The URL used in the autoupdate process. This URL points to the latest release of the server on github. (created for every push to the `main` branch)
- `PORT`: The port to use for the server. (default: `7810`)

---

## Usage

This server is intended to be used with the quickord app. The server listens for print requests and sends them to the printer. The server can be configured by going to [this website](https://app.quickord.com/venue/id/printer-settings).

Steps to use the server:

1. Launch the server with npm run start:dev.
2. Open the [Quickord](https://app.quickord.com) web app.
3. Start a new shift and select all the tables and/or delivery/takeaway orders that you want to print.

Every order now has a print button that you can use to print the order. Every new order (in the chosen shift tables) will be printed automatically.

After making settings changes on the website, you need to restart the server for the changes to take effect and to clear the double printing issue.

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

The Quickord app polls the printer server in an interval to check its status. The server listens for print requests and sends them to the printer. There are logs saved in the `app.log` file that can be used to troubleshoot any issues. It keeps the last 3 logs and rotates them.

The autoupdate process is done by checking the `CODE_UPDATE_URL` for the latest release. If there is a new release, the server will download the latest release and restart itself. The autoupdate process is done on every startup of the server. Autoupdate logs are saved in the `autoupdate.log` file. It keeps the last 3 logs and rotates them.

---

## Troubleshooting

If the server is not working as expected, you can check the logs in the `app.log` and `autoupdate.log` files. These logs are saved in the server folder. The logs keep the last 3 logs and rotate them.

- **The orders are double printing**: This can happen if the server is running multiple times or the Quickord app is open in multiple tabs. Make sure that the server is only running once and there is only one tab open. If the previous don't work, restart the server.
- **The server only prints X language**: The server prints the main language of the menu, if you want to print in another language you need to change the language of the menu in the Quickord app.
- **The print is scrambled and not Greek**: Check that the codepage matches the encoding you have chosen and is the correct for the specific printer. You can find the codepage in the printer's manual or the self test page.

## Troubleshooting building:

vcbuild.bat error on Windows
install c++ build tools etc on https://visualstudio.microsoft.com/visual-cpp-build-tools/
