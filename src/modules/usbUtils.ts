import { CharacterSet } from 'node-thermal-printer';
import { findBySerialNumber, WebUSB } from 'usb';

import { printTestPage, testUsbPrint } from './printer.ts';

const usbDriver = new WebUSB({
  allowAllDevices: true,
});

export const getUsbDevices = async () => usbDriver.getDevices();

export const getUsbDevice = async (serialNumber: string) =>
  usbDriver.requestDevice({
    filters: [
      {
        serialNumber,
      },
    ],
  });

// export const deezNuts = async () => {
//   const bufferData = (await printTestPage(
//     '192.168.1.1',
//     CharacterSet.ISO8859_7_GREEK,
//     true
//   )) as Buffer;

//   (await getUsbDevice('1234')).;
// };

export const sendDataToUsb = async (serialNumber: string, data: Buffer) => {
  // const device = await getUsbDevice(serialNumber);
  // const device = await findBySerialNumber(serialNumber);

  // if (!device) {
  //   throw new Error('Device not found');
  // }

  // await device.open();
  // await device.reset();
  // // await device.clearHalt('out', 1);
  // await device.claimInterface(0);
  // // console.log(device);
  // // console.log(JSON.stringify(device.configurations[0]?.interfaces[0], null, 2));

  // // await device.transferOut(1, Buffer.from('test'));

  // await device.releaseInterface(0);
  // await device.close();

  testUsbPrint();
};
