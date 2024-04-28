export const leftPad = (str: string, length: number, char = ' ') => {
  return str.padStart(length, char);
};

export const convertToDecimal = (value: number) => {
  return value / 100;
};
