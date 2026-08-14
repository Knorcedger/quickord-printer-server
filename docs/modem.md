# Modem

- [Modem](#modem)
  - [Drivers](#drivers)
  - [Modem AT Commands](#modem-at-commands)
  - [Setup](#setup)
  - [Multiple modems (one per phone line)](#multiple-modems-one-per-phone-line)

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

## Multiple modems (one per phone line)

A venue with two phone numbers can run one modem per number, so a second call
that arrives while the first is ringing is still shown.

Wiring — **one number per router port**:

```
                    ┌── Tel1 ──> SPLITTER ──┬──> PHONE #1  (main number)
ROUTER (VDSL/VoIP) ─┤                       └──> MODEM #1  (COM3)
                    └── Tel2 ──> SPLITTER ──┬──> PHONE #2  (secondary number)
                                            └──> MODEM #2  (COM4)
```

⚠️ Never join Tel1 and Tel2 into a single splitter: they are independent FXS
ports, each with its own feed.

Steps:

1. Check first, with an analog phone that shows caller id, that **each** router
   port displays the number of an incoming call. If it doesn't, the problem is
   the line/provider (CLIP), not the printer server.
2. Give every modem its own COM number (step 8 above) — the second one usually
   lands on COM10 or higher.
3. Add both modems in the printer settings page, one entry per COM port, and
   give each a label (e.g. "Main line" / "Delivery") — the label is what shows
   up in the logs.
4. Note which number rings which router port; the label should match it.

Routers often ring **both** FXS ports for every incoming call. In that case both
modems see the same call; the server drops the duplicate within a 5 second
window, so the venue still gets a single popup.
