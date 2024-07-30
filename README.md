# Printer server for quickord

## Table of Contents

- [Printer server for quickord](#printer-server-for-quickord)
  - [Table of Contents](#table-of-contents)
  - [Introduction](#introduction)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Usage](#usage)
  - [Printer setup](#printer-setup)
  - [Modem Setup](#modem-setup)
  - [How it works](#how-it-works)
  - [Troubleshooting](#troubleshooting)

---

## Introduction

This is a simple server that listens for print requests and sends them to a printer. It is intended to be used with the [Quickord Waiter](https://waiter.quickord.com) app. This server was created to be used with thermal printers that support ESC/POS commands. You can configure the local server by going to [this website](https://waiter.quickord.com/printer-server)

The printer server supports the following OS:

- `windows-x64`

---

## Installation

Requirements:

- [Node.js](https://nodejs.org/en/)
- [nmap](https://nmap.org/)

(specific versions that work with this project can be found in the `requirements` folder or bundled in `requirements.zip` in the [latest release](https://github.com/Knorcedger/quickord-printer-server/releases/latest))

1. Download the latest release from the [releases page](https://github.com/Knorcedger/quickord-printer-server/releases/latest) (`requirements.zip` and `quickord-printer-server.zip`)
2. Install Node.js and Nmap (bundled in `requirements.zip`).
3. Create a `Quickord` folder in the `C:\` drive.
4. Extract the contents of `quickord-printer-server.zip` to `C:\Quickord`.
5. Open a terminal and navigate to the `C:\Quickord` folder.
6. Run `npm install` to install the required dependencies.
7. Edit the `init.bat` file and replace `cd "printer server directory"` with the path to the `C:\Quickord` folder. (e.g. `cd "C:\Quickord"`)
8. Right click on the `init.bat` file and create a shortcut (send to desktop).
9. Rename the shortcut to `Quickord Printer Server`.
10. Run the `Quickord Printer Server` shortcut to start the server and verify that it works.
    The output should be this:

    ```cmd
    ℹ  info      nmap is already installed
    ℹ  info      Settings file not found. Creating new settings file.
    ℹ  info      API listening at port 7810
    ```

    [printer setup](#printer-setup)
11. If the server is running, you can now configure the server by going to [this website](https://waiter.quickord.com/printer-server)
12. look at the list of network printers and test them by clicking on the `test` button.
13. when the test prints something click on the add button.

---

## Configuration

The following are the printer settings that can be configured:

- `categoriesToNotPrint: Array<string>`: The categories (`_ids`) that should not be printed.
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
    "categoriesToNotPrint": [],
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
```

The server configs (in `config.json`) are:

- `CODE_UPDATE_URL`: The URL used in the autoupdate process. This URL points to the latest release of the server on github. (created for every push to the `main` branch)
- `PORT`: The port to use for the server. (default: `7810`)

---

## Usage

This server is intended to be used with the [Quickord Waiter](https://waiter.quickord.com) app. The server listens for print requests and sends them to the printer. The server can be configured by going to [this website](https://waiter.quickord.com/printer-server).

Steps to use the server:

1. Launch the server by running the `Quickord Printer Server` shortcut.
2. Open the [Quickord Waiter](https://waiter.quickord.com) web app.
3. Start a new shift and select all the tables and/or delivery/takeaway orders that you want to print.

Every order now has a print button that you can use to print the order. Every new order (in the chosen shift tables) will be printed automatically.

After making settings changes on the website, you need to restart the server for the changes to take effect and to clear the double printing issue.

---

## [Printer setup](docs/printer-setup.md)

---

## [Modem Setup](docs/modem.md)

---

## How it works

The Quickord waiter app polls the printer server in an interval to check its status. The server listens for print requests and sends them to the printer. There are logs saved in the `app.log` file that can be used to troubleshoot any issues. It keeps the last 3 logs and rotates them.

The autoupdate process is done by checking the `CODE_UPDATE_URL` for the latest release. If there is a new release, the server will download the latest release and restart itself. The autoupdate process is done on every startup of the server. Autoupdate logs are saved in the `autoupdate.log` file. It keeps the last 3 logs and rotates them.

---

## Troubleshooting

If the server is not working as expected, you can check the logs in the `app.log` and `autoupdate.log` files. These logs are saved in the server folder. The logs keep the last 3 logs and rotate them.

- **The orders are double printing**: This can happen if the server is running multiple times or the Quickord waiter web app is open in multiple tabs. Make sure that the server is only running once and there is only one tab open. If the previous don't work, restart the server.
- **The server only prints X language**: The server prints the main language of the menu, if you want to print in another language you need to change the language of the menu in the Quickord owner app.
- **The print is scrambled and not Greek**: Check that the codepage matches the encoding you have chosen and is the correct for the specific printer. You can find the codepage in the printer's manual or the self test page.
