import { SerialPortMock } from 'serialport';

import { __getRegistry, __setInitDelayMs, __setSerialPortImpl } from '../../src/modules/modem';

export const useFakePorts = (...paths: string[]) => {
  paths.forEach((p) =>
    SerialPortMock.binding.createPort(p, { echo: false, record: true })
  );
  __setSerialPortImpl(SerialPortMock as never);
  __setInitDelayMs(0);
};

export const dropAllFakePorts = () => SerialPortMock.binding.reset();

export const instanceFor = (port: string) => __getRegistry().get(port);

// The live mock binding of an open instance, used to push bytes at the server.
const bindingOf = (port: string) =>
  (instanceFor(port)?.serial as unknown as { port: { recording: Buffer } })
    ?.port;

export const recordingOf = (port: string) =>
  bindingOf(port)?.recording?.toString() ?? '';

export const cid = (number: string, fmt: 'chc' | 'direct' = 'direct') =>
  fmt === 'direct'
    ? `RING\r\nDATE = 0718\r\nTIME = 1730\r\nNMBR = ${number}\r\nRING\r\n`
    : `RING\r\nDATE 0408\r\nTIME 1355\r\nNMBR ${number}\r\n`;

export const emit = (port: string, data: string) =>
  (bindingOf(port) as unknown as { emitData: (b: Buffer) => void }).emitData(
    Buffer.from(data)
  );

export const ring = (
  port: string,
  number: string,
  fmt: 'chc' | 'direct' = 'direct'
) => emit(port, cid(number, fmt));
