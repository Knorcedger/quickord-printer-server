import { transliterate } from 'transliteration';

export const leftPad = (str: string, length: number, char = ' ') => {
  return str.padStart(length, char);
};

export const convertToDecimal = (value: number) => {
  return value / 100;
};

export const tr = (text: string, execute: boolean): string => {
  try {
    if (execute) {
      return transliterate(text, {
        trim: true,
      });
    }

    return text;
  } catch {
    return text;
  }
};
