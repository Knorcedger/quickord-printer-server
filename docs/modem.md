# Modem

- [Modem](#modem)
  - [Drivers](#drivers)
  - [Modem AT Commands](#modem-at-commands)
  - [Setup](#setup)

## Drivers

- [Linux](http://www.linuxant.com/drivers/dgc/downloads.php)
- **Windows** don't need drivers

## Modem AT Commands

[PDF Reference](./IML56_modem_AT_commands.pdf)

- Modem commands need to end in `\r` (carriage return), after which the modem will respond with `OK` or `ERROR`.

## Setup

1. Connect the phone line to the splitter, one of the splitter outputs to the modem and the other to the phone.
2. Turn off the printer server if it's on.
3. **Connect the modem to the computer** using a USB cable.
4. Open run *(with `win+R` or by searching `run` or `εκτέλεση`)* and type `devmgmt.msc` to open the device manager.
  ![Run](./assets/image%20(3).png)
5. Find the modem in the device manager.
6. Right click on the modem and select `Properties`.
  ![Device Manager](./assets/image%20(4).png)
7. In the properties window, go to the `Advanced` tab and click on `Advanced Port Settings`.
   ![Modem Properties](./assets/image%20(5).png)
8. In the `Advanced Port Settings` window, change the `COM Port Number` to any available ports and click `OK`.
   ![Advanced Port Settings](./assets/image%20(6).png)
9. Setup the modem in the printer server settings.
10. Launch the printer server by running the `Quickord Printer Server` shortcut.
11. If correct, any calls should be forwarded to the quickoed BE server.
