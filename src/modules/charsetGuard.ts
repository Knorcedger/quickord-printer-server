/**
 * Keeps a ThermalPrinter on its configured code page for the whole print.
 *
 * node-thermal-printer's append() switches the active code page permanently
 * when it meets a character the current one lacks. CP737/CP869 have no `€`,
 * so the first price flipped Greek printers to ISO-8859-7 and every Greek
 * label after it came out as box-drawing glyphs. Replacing unencodable
 * characters here means the lib never has a reason to switch.
 */
import iconv from 'iconv-lite';
import { CharacterSet, printer as ThermalPrinter } from 'node-thermal-printer';

const FALLBACK_ENCODING = 'WIN1253';

// iconv encoding registered per guarded printer instance.
const encodings = new WeakMap<object, string>();

// ASCII stand-ins for symbols the Greek DOS code pages lack.
const SYMBOL_FALLBACKS: Record<string, string> = {
  '–': '-',
  '—': '-',
  '…': '...',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '→': '->',
  '×': 'x',
  '€': 'EUR',
};

const isAscii = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
};

// Same probe the lib uses: iconv yields '?' for characters the page lacks.
const encodable = (ch: string, encoding: string): boolean => {
  try {
    return iconv.encode(ch, encoding).toString() !== '?';
  } catch {
    return false;
  }
};

const stripDiacritics = (ch: string): string =>
  ch.normalize('NFD').replace(/[̀-ͯ]/g, '');

export const sanitizeForEncoding = (text: string, encoding: string): string => {
  if (isAscii(text)) return text;

  let out = '';
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80 || encodable(ch, encoding)) {
      out += ch;
      continue;
    }
    const fallback = SYMBOL_FALLBACKS[ch];
    if (fallback !== undefined) {
      out += fallback;
      continue;
    }
    const plain = stripDiacritics(ch);
    out += plain !== ch && encodable(plain, encoding) ? plain : '?';
  }
  return out;
};

// Wraps the instance's append() so every print/println/leftRight/table call
// is sanitized before the lib sees it. Buffers pass through untouched.
export const installCharsetGuard = (
  printer: ThermalPrinter,
  characterSet: CharacterSet | string | undefined
): ThermalPrinter => {
  const raw = printer as any;
  const encoding: string =
    raw.printer?.config?.CODE_PAGES?.[characterSet ?? ''] ?? FALLBACK_ENCODING;
  encodings.set(printer, encoding);

  const originalAppend = raw.append.bind(printer);
  raw.append = (text: unknown) =>
    originalAppend(
      typeof text === 'string' ? sanitizeForEncoding(text, encoding) : text
    );
  return printer;
};

// For lines whose spacing is computed from the string length before printing:
// sanitize first so a `€` → `EUR` swap cannot push the line past the paper.
export const sanitizeForPrinter = (
  printer: ThermalPrinter,
  text: string
): string => {
  const encoding = encodings.get(printer);
  return encoding ? sanitizeForEncoding(text, encoding) : text;
};
