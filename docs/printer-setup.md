# Printer setup

- [Printer setup](#printer-setup)
  - [Network printers](#network-printers)
  - [USB printers](#usb-printers)

## Network printers

1. Launch the server by running the `Quickord Printer Server` shortcut.
2. Open the dashboard by going to [this website](https://waiter.quickord.com/printer-server).
3. Find the printer IP address by printing a self test page.
4. Test the printer by clicking on the `test` button next to the correct IP address.
5. If the test prints something click on the `add` button to add the printer to the list of printers.
6. Configure the printer below.

If there are issues with the printer check the printer manual for further instructions

---

## USB printers

1. Launch the server by running the `Quickord Printer Server` shortcut.
2. Open the dashboard by going to [this website](https://waiter.quickord.com/printer-server).
3. Connect the USB printer to the computer.
4. (optional) Install the printer driver.
5. Open the windows printer settings.
6. Find the printer in the list of printers.
7. Right click on the printer and select `Printer properties`.
8. Share the printer and give it a name. (e.g. `QuickordPrinter`)
9. On the dashboard click on the `Add new printer manually` button.
10. On the new printer form fill in the `PORT` field with the following format: `\\localhost\printer-name`. (e.g. `\\localhost\QuickordPrinter`)
11. Click on the `test` button to test the printer.
12. Configure the rest of the printer settings.

If there are issues with the printer check the printer manual for further instructions. If the manual does not help, then you will need to troubleshoot windows printer sharing.
