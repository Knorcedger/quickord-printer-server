import { exec } from 'child_process';
import { promisify } from 'util';
import { transliterate } from 'transliteration';
import { printer as ThermalPrinter } from 'node-thermal-printer';
import { PrinterTextSize } from './settings';
import { z } from 'zod';
import { DEFAULT_CODE_PAGE, changeCodePage } from './printer';
import { SupportedLanguages, translations } from './translations';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { curlExecBuffer, httpStatusError, tryFetchWithFallback } from './http';
import { reportFetchFailure } from './api';

const execAsync = promisify(exec);

// Canonical Windows shared-printer online check, shared by the legacy
// /available status path (printer.ts) and the WS print path (wsClient.ts) so the
// WMI query and its quoting live in one place and the two can't diverge.
// Escapes single quotes (the WQL/PowerShell escape is doubling).
// Verified on a venue Windows machine: WorkOffline flips False->True within
// ~10s of powering a shared USB printer off, so it tracks real connectivity.
export const isUSBPrinterOnline = async (
  shareName: string
): Promise<boolean> => {
  const safeShareName = shareName.replace(/'/g, "''");
  const command = `powershell -NoProfile -Command "Get-WmiObject -Query \\"SELECT * FROM Win32_Printer WHERE ShareName = '${safeShareName}'\\" | Select-Object -ExpandProperty WorkOffline"`;
  try {
    const { stdout } = await execAsync(command);
    return stdout.trim().toLowerCase() === 'false';
  } catch {
    return false;
  }
};

export const leftPad = (str: string, length: number, char = ' ') => {
  return str.padStart(length, char);
};
import { AadeInvoice } from './interfaces';
export const convertToDecimal = (value: number) => {
  return value / 100;
};

export const normalizeGreek = (text: string): string => {
  // Remove Greek diacritics (tonos, dialytika, etc.)
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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

export const changeTextSize = (
  printer: ThermalPrinter,
  size: z.infer<typeof PrinterTextSize>
) => {
  switch (size) {
    case 'ONE':
      printer.setTextSize(1, 1);
      return;
    case 'TWO':
      printer.setTextSize(2, 2);
      return;
    case 'THREE':
      printer.setTextSize(3, 3);
      return;
    case 'NORMAL':
    default:
      printer.setTextNormal();
  }
};

// Cache configuration
const CACHE_DIR = path.join(process.cwd(), '.image-cache');
const CACHE_EXPIRY_DAYS = 3; // Cache images for 3 days

// Create cache directory if it doesn't exist
const ensureCacheDir = () => {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
};

// Generate a cache key from URL
const getCacheKey = (url: string): string => {
  return crypto.createHash('md5').update(url).digest('hex');
};

// Get cached image if it exists and is not expired
const getCachedImage = (url: string): Buffer | null => {
  try {
    ensureCacheDir();
    const cacheKey = getCacheKey(url);
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.png`);

    if (fs.existsSync(cachePath)) {
      const stats = fs.statSync(cachePath);
      const ageInDays =
        (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

      if (ageInDays < CACHE_EXPIRY_DAYS) {
        const cached = fs.readFileSync(cachePath);
        // A truncated entry (process died mid-write) would throw deep inside the
        // PNG decoder and silently drop the image for the whole TTL — drop it here.
        if (cached.length) {
          console.log(`Using cached image for: ${url}`);
          return cached;
        }
      }
      fs.unlinkSync(cachePath);
    }
  } catch (err) {
    console.error('Error reading cache:', err);
  }
  return null;
};

// Save image to cache
const saveCachedImage = (url: string, buffer: Buffer): void => {
  try {
    ensureCacheDir();
    const cacheKey = getCacheKey(url);
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.png`);
    // Write to a temp file and rename so a crash mid-write can never leave a
    // partial entry behind (which would poison the cache for its whole TTL).
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, cachePath);
    console.log(`Cached image for: ${url}`);
  } catch (err) {
    console.error('Error saving cache:', err);
  }
};

const downloadAndProcessImage = async (url: string): Promise<Buffer> => {
  // Check cache first
  const cachedImage = getCachedImage(url);
  if (cachedImage) {
    return cachedImage;
  }

  try {
    const result = await tryFetchWithFallback<Buffer>({
      url,
      method: 'GET',
      fetchFn: async () => {
        const response = await fetch(url, {
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          },
        });
        if (!response.ok) throw httpStatusError(response);
        return { data: Buffer.from(await response.arrayBuffer()) };
      },
      curlFn: () =>
        // Use curl with flags:
        // -s = silent
        // -L = follow redirects
        // -A = custom User-Agent
        // --fail = exit non-zero if HTTP error
        curlExecBuffer(
          `curl -s -L --fail -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" "${url}"`
        ),
    });

    if (result.viaFallback && result.fetchFailure) {
      reportFetchFailure(result.fetchFailure).catch(() => {});
    }

    // Bayer 8x8 ordered-dither matrix, normalized to 0-255
    const BAYER_8 = [
      [0, 32, 8, 40, 2, 34, 10, 42],
      [48, 16, 56, 24, 50, 18, 58, 26],
      [12, 44, 4, 36, 14, 46, 6, 38],
      [60, 28, 52, 20, 62, 30, 54, 22],
      [3, 35, 11, 43, 1, 33, 9, 41],
      [51, 19, 59, 27, 49, 17, 57, 25],
      [15, 47, 7, 39, 13, 45, 5, 37],
      [63, 31, 55, 23, 61, 29, 53, 21],
    ].map((row) => row.map((v) => (v + 0.5) * (256 / 64)));

    // Only trim away transparent padding (e.g. a logo centred in a square
    // canvas). Logos with an opaque background are left untouched, so their
    // intended framing and edge glyphs are never clipped.
    const cornerAlpha = (
      await sharp(result.data)
        .ensureAlpha()
        .extract({ height: 1, left: 0, top: 0, width: 1 })
        .raw()
        .toBuffer()
    )[3]!;

    let pipeline = sharp(result.data)
      .resize(300)
      .ensureAlpha()
      .flatten({ background: '#ffffff' }); // transparent → white
    if (cornerAlpha < 10) {
      pipeline = pipeline.trim({ threshold: 10 });
    }

    const { data, info } = await pipeline
      .grayscale()
      .normalise()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const out = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const gray = data[(y * width + x) * channels]!; // 0=black, 255=white
        const t = BAYER_8[y & 7]![x & 7]!;
        out[y * width + x] = gray > t ? 255 : 0;
      }
    }

    const processedImage = await sharp(out, {
      raw: { width, height, channels: 1 },
    })
      .png()
      .toBuffer();

    // Save to cache
    saveCachedImage(url, processedImage);

    return processedImage;
  } catch (err: any) {
    console.error('Failed to download or process image:', err.message || err);
    throw new Error('Image download or processing failed');
  }
};

export const PaymentMethod = Object.freeze({
  ACC_FOREIGN: {
    description: 'Επαγ. Λογαριασμός Πληρωμών Αλλοδαπής',
    value: '2',
  },
  ACC_NATIVE: {
    description: 'Επαγ. Λογαριασμός Πληρωμών Ημεδαπής',
    value: '1',
  },
  CASH: { description: 'ΜΕΤΡΗΤΑ', value: '3' },
  CHECK: { description: 'ΕΠΙΤΑΓΗ', value: '4' },
  CREDIT: { description: 'ΕΠΙ ΠΙΣΤΩΣΕΙ', value: '5' },
  IRIS: { description: 'IRIS', value: '8' },
  POS: { description: 'POS / e-POS', value: '7' },
  WEB_BANK: { description: 'Web-banking', value: '6' },
});

export const readMarkdown = async (
  text,
  printer,
  alignment,
  settings,
  uppercase = false
) => {
  if (alignment === 'left') {
    printer.alignLeft();
  } else if (alignment === 'center') {
    printer.alignCenter();
  } else if (alignment === 'right') {
    printer.alignRight();
  }
  console.log(`Printing text with alignment ${text}`);
  let index = 0;
  let buffer = '';
  let formatting = { bold: false, italic: false, underline: false };

  while (index < text.length) {
    if (text[index] === '<') {
      // Check for img tag first
      const imgMatch = text.slice(index).match(/^<img>(.*?)<\/img>/);
      if (imgMatch) {
        // Print current buffer before processing image
        if (buffer) {
          printer.bold(formatting.bold);
          printer.underline(formatting.underline);
          changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
          printer.print(
            tr(
              uppercase ? buffer.toUpperCase() : buffer,
              settings?.transliterate
            )
          );
          buffer = '';
        }

        const imageUrl = imgMatch[1].trim();
        try {
          console.log(`Downloading and processing image from: ${imageUrl}`);
          const processedImageBuffer = await downloadAndProcessImage(imageUrl);
          // printImageBuffer is async — without the await the raster bytes race
          // the rest of the receipt and can be dropped from the buffer.
          await printer.printImageBuffer(processedImageBuffer);
        } catch (error) {
          console.error(
            `Failed to download/process image from ${imageUrl}:`,
            error
          );
        }

        index += imgMatch[0].length;
        continue;
      }

      // Check for qr tag
      const qrMatch = text.slice(index).match(/^<qr>(.*?)<\/qr>/);
      if (qrMatch) {
        // Print current buffer before processing QR code
        if (buffer) {
          printer.bold(formatting.bold);
          printer.underline(formatting.underline);
          changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
          printer.print(
            tr(
              uppercase ? buffer.toUpperCase() : buffer,
              settings?.transliterate
            )
          );
          buffer = '';
        }

        const qrUrl = qrMatch[1].trim();
        try {
          console.log(`Printing QR code for: ${qrUrl}`);
          printer.printQR(qrUrl, {
            cellSize: 4,
            model: 4,
            correction: 'Q',
          });
        } catch (error) {
          console.error(`Failed to print QR code for ${qrUrl}:`, error);
        }

        index += qrMatch[0].length;
        continue;
      }

      // Check for other tags
      const tagMatch = text.slice(index).match(/^<(\/?)(b|u|s1|s2|s3|s4)>/);
      if (tagMatch) {
        // Print current buffer before changing formatting
        if (buffer) {
          printer.bold(formatting.bold);
          printer.underline(formatting.underline);
          changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
          printer.print(
            tr(
              uppercase ? buffer.toUpperCase() : buffer,
              settings?.transliterate
            )
          );
          buffer = '';
        }

        const [, closing, tag] = tagMatch;
        if (closing) {
          // Closing tag
          if (tag === 'b') formatting.bold = false;
          if (tag === 'u') formatting.underline = false;
          if (tag === 's1' || tag === 's2' || tag === 's3') {
            changeTextSize(printer, 'NORMAL');
          }
        } else {
          // Opening tag
          if (tag === 'b') formatting.bold = true;
          if (tag === 'u') formatting.underline = true;
          if (tag === 's1') {
            printer.setTextSize(1, 0);
          } else if (tag === 's2') {
            printer.setTextSize(1, 1);
          } else if (tag === 's3') {
            printer.setTextSize(2, 2);
          } else if (tag === 's4') {
            printer.setTextSize(3, 3);
          }
        }

        index += tagMatch[0].length;
        continue;
      }
    }

    // Handle newline
    if (text[index] === '\n') {
      printer.bold(formatting.bold);
      printer.underline(formatting.underline);
      changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
      printer.println(
        tr(uppercase ? buffer.toUpperCase() : buffer, settings?.transliterate)
      );
      buffer = '';
      index++;
      continue;
    }

    // Regular character
    buffer += text[index];
    index++;
  }

  // Print any remaining text
  if (buffer) {
    printer.bold(formatting.bold);
    printer.underline(formatting.underline);
    changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
    printer.print(tr(buffer, settings?.transliterate));
  }
};
export const formatToGreek = (date: Date | string): string => {
  const entryDate = new Date(date);
  return entryDate.toLocaleString('el-GR', {
    timeZone: 'Europe/Athens',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

export const formatLine = (left, right) => {
  const space = 40 - left.length - right.length;
  return left + ' '.repeat(space > 0 ? space : 1) + right;
};

export const drawLine2 = (printer: ThermalPrinter) => {
  printer.println('------------------------------------------');
};

export type ServiceType = {
  value: string;
  label_en: string;
  label_el: string;
};

export const SERVICES: Record<string, ServiceType> = {
  wolt: {
    value: 'wolt',
    label_en: 'WOLT',
    label_el: 'WOLT',
  },
  wolt_drive: {
    value: 'wolt_drive',
    label_en: 'WOLT DRIVE',
    label_el: 'WOLT DRIVE',
  },
  efood: {
    value: 'efood',
    label_en: 'EFOOD',
    label_el: 'EFOOD',
  },
  efood_last_mile: {
    value: 'efood_last_mile',
    label_en: 'EFOOD LAST MILE',
    label_el: 'EFOOD LAST MILE',
  },
  box: {
    value: 'box',
    label_en: 'BOX',
    label_el: 'BOX',
  },
  fagi: {
    value: 'fagi',
    label_en: 'FAGI',
    label_el: 'FAGI',
  },
  store: {
    value: 'store',
    label_en: 'STORE',
    label_el: 'ΚΑΤΑΣΤΗΜΑ',
  },
  phone: {
    value: 'phone',
    label_en: 'PHONE',
    label_el: 'ΤΗΛΕΦΩΝΟ',
  },
  takeAway: {
    value: 'takeAway',
    label_en: 'TAKE AWAY',
    label_el: 'TAKE AWAY',
  },
  take_away_package: {
    value: 'take_away_package',
    label_en: 'TAKE AWAY PACKAGE',
    label_el: 'TAKE AWAY ΠΑΚΕΤΟ',
  },
  dine_in: {
    value: 'dineIn',
    label_en: 'DINE IN',
    label_el: 'DINE IN',
  },
  delivery: {
    value: 'delivery',
    label_en: 'DELIVERY',
    label_el: 'ΔΙΑΝΟΜΗ',
  },
  generic: {
    value: 'generic',
    label_en: 'GENERIC',
    label_el: 'ΓΕΝΙΚΗ',
  },
  take_away_inside: {
    value: 'take_away_inside',
    label_en: 'TAKE AWAY INSIDE',
    label_el: 'ΠΑΡΑΛΑΒΗ ΕΝΤΟΣ',
  },
  kiosk: {
    value: 'kiosk',
    label_en: 'KIOSK',
    label_el: 'KIOSΚ',
  },
  kiosk_inside: {
    value: 'kiosk_inside',
    label_en: 'KIOSK DINE IN',
    label_el: 'KIOSK DINE IN',
  },
  kiosk_package: {
    value: 'kiosk_package',
    label_en: 'KIOSK PACKAGE',
    label_el: 'KIOSK ΠΑΚΕΤΟ',
  },
  on_the_go: {
    value: 'on_the_go',
    label_en: 'ON THE GO',
    label_el: 'ΣΤΟ ΧΕΡΙ',
  },
  self_service_dine_in: {
    value: 'self_service_dine_in',
    label_en: 'SELF SERVICE',
    label_el: 'ΑΥΤΟΕΞΥΠΗΡΕΤΗΣΗ',
  },
};

export const DISCOUNTTYPES: Record<string, ServiceType> = {
  fixed: {
    value: 'fixed',
    label_en: 'FIXED',
    label_el: 'ΣΤΑΘΕΡΗ',
  },
  percent: {
    value: 'percent',
    label_en: 'PERCENTAGE',
    label_el: 'ΠΟΣΟΣΤΟ',
  },
  none: {
    value: 'none',
    label_en: 'UNKNOWN',
    label_el: 'ΑΓΝΩΣΤΗ',
  },
};

export const printMarks = (
  printer,
  aadeInvoice,
  lang,
  transliterate: boolean = false
) => {
  printer.newLine();
  printer.alignLeft();
  printer.println(`MARK ${aadeInvoice?.mark}`);
  printer.println(`UID ${aadeInvoice?.uid}`);
  printer.println(`AUTH ${aadeInvoice?.authentication_code}`);
  printer.alignCenter();
  printer.printQR(aadeInvoice?.url, {
    cellSize: 4,
    model: 4,
    correction: 'Q',
  });
  printer.newLine();
  const url = aadeInvoice?.url;

  let providerUrl = '';
  console.log('Invoice URL:', url);
  if (url.includes('invoiceportal')) {
    providerUrl = 'www.invoiceportal.gr';
  } else if (url.includes('etimologiera')) {
    providerUrl = 'www.etimologiera.gr';
  }
  printer.println(
    tr(
      `${translations.printOrder.provider[lang]} ${providerUrl}`,
      transliterate
    )
  );
  printer.newLine();
};
export const printPayments = (
  printer,
  aadeInvoice,
  lang,
  transliterate: boolean = false,
  tip: number = 0
) => {
  printer.bold(false);
  printer.alignCenter();
  drawLine2(printer);
  printer.println(
    tr(`${translations.printOrder.payments[lang]}:`, transliterate)
  );
  const methods = aadeInvoice?.payment_methods ?? [];
  // The tip is collected on top of the fiscal amount, so it isn't part of any
  // payment_method amount. Fold it into the primary (largest) payment so the
  // printed payments reflect the money actually collected. `tip` is in cents.
  let tipIdx = -1;
  if (tip > 0) {
    let max = 0;
    methods.forEach((m: any, i: number) => {
      if (m.amount > max) {
        max = m.amount;
        tipIdx = i;
      }
    });
  }
  methods.forEach((detail: any, i: number) => {
    const amount = detail.amount + (i === tipIdx ? tip / 100 : 0);
    if (amount > 0) {
      const method = PaymentMethod[detail.code];
      const methodDescription =
        method?.description || translations.printOrder.unknown[lang];
      console.log('Printing payment method:', methodDescription, method);
      printer.println(
        `${tr(`${methodDescription}     ${translations.printOrder.amount[lang]}`, transliterate)}: ${amount.toFixed(2)}€`
      );
    }
    drawLine2(printer);
  });
};

export const getTitle = (content: any[], lang: string): string => {
  return (
    content?.find((c) => c.language === lang)?.title ||
    content?.find((c) => c.language === 'en')?.title ||
    ''
  );
};

interface OptionChoice {
  content: { language: string; title?: string | null; description?: string }[];
  amountLevel?: string | null;
  quantity?: number;
  price?: number;
}

interface ProductOption {
  content: { language: string; title?: string | null; description?: string }[];
  choices?: OptionChoice[];
}

export const printOptionDetails = (
  printer,
  options: ProductOption[],
  lang: string,
  settings: any
) => {
  options?.forEach((option) => {
    let optionLabel = normalizeGreek(getTitle(option.content, lang))
      .toUpperCase()
      .trim();
    if (!optionLabel.endsWith(':') && optionLabel.length > 0) {
      optionLabel = `${optionLabel}: `;
    } else if (optionLabel.length > 0) {
      optionLabel += ' ';
    }

    const choiceValues: string[] = [];
    let totalPrice = 0;

    option.choices?.forEach((choice) => {
      const amountLevel =
        translations.printOrder.amountLevel?.[lang]?.[choice.amountLevel] || '';
      const quantityPrefix =
        Number(choice.quantity) > 1 ? `${choice.quantity}x ` : '';
      const title = normalizeGreek(getTitle(choice.content, lang));
      choiceValues.push(
        `${amountLevel}${amountLevel ? ' ' : ''}${quantityPrefix}${title}`.trim()
      );
      if (choice.price && choice.price > 0)
        totalPrice += choice.price * (Number(choice.quantity) || 1);
    });

    const indent = '     ';
    let priceStr = '';
    if (
      totalPrice > 0 &&
      (settings.priceOnOrder === undefined || settings.priceOnOrder === true)
    ) {
      priceStr = `   ${(totalPrice / 100).toFixed(2)} €`;
    }
    const lineWidth = settings?.textOptions?.includes('BOLD_PRODUCTS')
      ? 21
      : 42;
    const continuationIndent = `${indent}  `;
    const firstPrefix = `${indent}- ${optionLabel}`;
    const lines = wrapChoicesByCommas(
      choiceValues,
      lineWidth,
      firstPrefix,
      continuationIndent,
      priceStr.length
    );
    lines.forEach((wrapped, idx) => {
      const isLast = idx === lines.length - 1;
      let out = wrapped;
      if (isLast && priceStr.length > 0) {
        const padded =
          out.length + priceStr.length <= lineWidth
            ? out.padEnd(lineWidth - priceStr.length)
            : out;
        out = padded + priceStr;
      }
      printer.println(tr(out, settings.transliterate));
    });
  });
};

const wrapChoicesByCommas = (
  choices: string[],
  width: number,
  firstPrefix: string,
  continuationIndent: string,
  lastLineReserved: number
): string[] => {
  if (choices.length === 0) return [firstPrefix];

  const lines: string[] = [];
  let current = firstPrefix;

  const pushCurrent = () => {
    lines.push(current);
    current = continuationIndent;
  };

  const hardChunkInto = (segment: string) => {
    let rem = segment;
    while (rem.length > 0) {
      const avail = width - current.length;
      if (avail <= 0) {
        pushCurrent();
        continue;
      }
      current += rem.slice(0, avail);
      rem = rem.slice(avail);
      if (rem.length > 0) pushCurrent();
    }
  };

  choices.forEach((choice, i) => {
    const sep = i === 0 ? '' : ', ';
    if (current.length + sep.length + choice.length <= width) {
      current += sep + choice;
      return;
    }
    if (i > 0) {
      if (current.length + 1 <= width) current += ',';
      pushCurrent();
    }
    if (current.length + choice.length <= width) {
      current += choice;
    } else {
      hardChunkInto(choice);
    }
  });

  if (current.length > 0) lines.push(current);

  if (
    lastLineReserved > 0 &&
    lines.length > 0 &&
    lines[lines.length - 1]!.length + lastLineReserved > width
  ) {
    lines.push(continuationIndent);
  }

  return lines;
};

export const printProductDiscount = (
  printer,
  discount,
  lang,
  transliterate = false
) => {
  if (discount?.amount && discount?.type) {
    const indent = '     ';
    let discountText = '';
    if (discount.type === 'FIXED') {
      discountText = `${(discount.amount / 100).toFixed(2)}€`;
    } else if (discount.type === 'PERCENTAGE' || discount.type === 'PERCENT') {
      discountText = `${discount.amount}%`;
    }
    if (discountText) {
      printer.println(
        `${indent}${tr(`${translations.printOrder.discount[lang]}`, transliterate)}: -${discountText}`
      );
    }
  }
};

export const printProducts = (
  printer,
  aadeInvoice,
  order: any = {},
  settings,
  lang,
  discounts: any[] = [],
  showOptions: boolean = true
): [number, number, any[]] => {
  let sumAmount = 0;
  let sumQuantity = 0;
  printer.alignCenter();
  printer.newLine();
  printer.alignLeft();
  printer.println(
    tr(
      `${translations.printOrder.quantity[lang]}`,
      settings.transliterate
    ).padEnd(7) +
      tr(
        `${translations.printOrder.kind[lang]}`,
        settings.transliterate
      ).padEnd(20) +
      tr(
        `${translations.printOrder.price[lang]}`,
        settings.transliterate
      ).padEnd(10) +
      tr(`${translations.printOrder.vat[lang]}`, settings.transliterate)
  );
  drawLine2(printer);
  const vatBreakdown = new Map();
  const detailsArr = aadeInvoice?.details ?? [];
  detailsArr.forEach((detail: any, idx: number) => {
    const isCredit = detail.rec_type === 7;
    const sign = isCredit ? -1 : 1;

    const rawNet = detail.net_value || 0;
    const rawTax = detail?.tax?.value || 0;
    const rawTotal = rawNet + rawTax;
    const signedQuantity = sign * detail.quantity;
    const signedNet = sign * rawNet;
    const signedTotal = sign * rawTotal;

    sumQuantity += signedQuantity;
    sumAmount += signedTotal;

    const matchedProduct = order?.products?.find((p: any) =>
      p.content?.some(
        (c: any) =>
          typeof c?.title === 'string' &&
          c.title.trim().toLowerCase() ===
            String(detail.name).trim().toLowerCase()
      )
    );
    const localizedTitle =
      (matchedProduct && getTitle(matchedProduct.content, lang)) || detail.name;

    const name = tr(
      normalizeGreek(String(localizedTitle).toUpperCase()),
      settings.transliterate
    );

    const quantity = signedQuantity.toFixed(0); // "-1" for credits
    const value = rawTotal.toFixed(2);
    const vat = `${detail.tax.rate}%`;
    const maxNameLength = 17;
    const vatRate = Number(detail.tax.rate);

    if (vatBreakdown.has(vatRate)) {
      const entry = vatBreakdown.get(vatRate);
      entry.total += signedTotal;
      entry.netValue += signedNet;
      entry.vatAmount = entry.total - entry.netValue;
    } else {
      vatBreakdown.set(vatRate, {
        vat: vatRate,
        total: signedTotal,
        netValue: signedNet,
        vatAmount: signedTotal - signedNet,
      });
    }

    if (isCredit) {
      if (idx > 0) drawLine2(printer);
      printer.println(
        tr(
          `${translations.printOrder.quantityReduced[lang]}`,
          settings.transliterate
        )
      );
    }

    if (name.length > maxNameLength) {
      // Print wrapped product name in chunks
      for (let i = 0; i < name.length; i += maxNameLength) {
        const chunk = name.substring(i, i + maxNameLength);

        if (i === 0) {
          // First line → quantity first
          printer.println(
            quantity.padEnd(7) +
              chunk.padEnd(maxNameLength) +
              '  ' +
              value.padStart(7) +
              vat.padStart(10)
          );
        } else {
          // Subsequent lines → only print name aligned after quantity
          printer.println(' '.repeat(7) + chunk);
        }
      }
    } else {
      // Short name → print in one line with quantity first
      printer.println(
        quantity.padEnd(7) +
          name.padEnd(maxNameLength) +
          '  ' +
          value.padStart(7) +
          vat.padStart(10)
      );
    }
    if (
      showOptions &&
      settings.documentsToPrint?.includes('OPTION-DETAILS') &&
      matchedProduct?.options
    ) {
      console.log('Printing details:', JSON.stringify(matchedProduct.options));
      printOptionDetails(printer, matchedProduct.options, lang, settings);

      // Check if discount matches by productId (template), _id (instance), or content _id
      const productDiscount = discounts.find((d: any) => {
        if (!d.productId) return false;

        // Match by product template ID
        if (d.productId === matchedProduct.productId) return true;

        // Match by product instance ID
        if (d.productId === matchedProduct._id) return true;

        // Match by content item _id
        const matchingContent = matchedProduct.content?.find(
          (c: any) => c._id === d.productId
        );
        if (matchingContent) return true;

        return false;
      });
      console.log('Found productDiscount:', productDiscount);

      printProductDiscount(printer, productDiscount, lang);
    }

    if (
      isCredit &&
      idx < detailsArr.length - 1 &&
      detailsArr[idx + 1]?.rec_type !== 7
    ) {
      drawLine2(printer);
    }
  });

  drawLine2(printer);
  const fixedBreakdown = [...vatBreakdown.values()].map((entry) => ({
    ...entry,
    vatAmount: Number((entry.total - entry.netValue).toFixed(2)),
  }));

  return [sumAmount, sumQuantity, fixedBreakdown];
};

export const printDiscountAndTip = (
  printer,
  discounts,
  tip,
  lang,
  transliterate: boolean = false
) => {
  // Filter out product-specific discounts - only print overall discounts
  const overallDiscounts = Array.isArray(discounts)
    ? discounts.filter((d: any) => !d.productId)
    : [];

  // Print each overall discount
  overallDiscounts.forEach((discount: any) => {
    if (discount.amount && discount.type) {
      let discountAmount = '';
      if (discount.type === 'FIXED') {
        discountAmount = (discount.amount / 100).toFixed(2) + '€';
      } else if (
        discount.type === 'PERCENTAGE' ||
        discount.type === 'PERCENT'
      ) {
        discountAmount = discount.amount.toString() + '%';
      }
      if (discountAmount !== '') {
        printer.println(
          `${tr(`${translations.printOrder.discount[lang]}`, transliterate)}: ${discountAmount}, ${tr(DISCOUNTTYPES[discount.type.toLocaleLowerCase()]?.label_el || '', transliterate)}`
        );
      }
    }
  });

  if (tip > 0) {
    printer.println(
      `${tr(`${translations.printOrder.tip[lang]}`, transliterate)}: ${(tip / 100).toFixed(2)}€`
    );
  }
};

export const printVatBreakdown = (
  printer,
  vatBreakdown,
  lang,
  transliterate: boolean = false
) => {
  printer.println(
    tr(`${translations.printOrder.percentage[lang]}`, transliterate).padEnd(
      10
    ) +
      tr(`${translations.printOrder.netWorth[lang]}`, transliterate).padEnd(
        12
      ) +
      tr(`${translations.printOrder.netValue[lang]}`, transliterate).padEnd(
        10
      ) +
      tr(`${translations.printOrder.total[lang]}`, transliterate).padStart(10)
  );

  vatBreakdown.forEach((entry) => {
    printer.println(
      `${String(entry.vat).padEnd(10)}${String(entry.netValue.toFixed(2)).padEnd(12)}${String(entry.vatAmount.toFixed(2)).padEnd(10)}${String(entry.total.toFixed(2)).padStart(10)}`
    );
  });

  drawLine2(printer);
};
/**
 * Resolves the document title for an AADE invoice. Mirrors the FE rule
 * (InvoiceTemplate.tsx): code 1.1/9.3 + move_purpose means the document also
 * acts as a delivery note, so the title changes accordingly.
 *
 * TODO: the real source of truth should be an `isDeliveryNote` flag on the
 * invoice header, but it is not being stored correctly yet, so for now we
 * infer it from header.code + move_purpose like the FE does.
 */
export const getInvoiceTypeLabel = (
  aadeInvoice: AadeInvoice,
  lang: SupportedLanguages
): string => {
  const code = aadeInvoice?.header?.code;
  const hasMovePurpose = !!aadeInvoice?.move_purpose?.code;

  if (code === '5.1') {
    return translations.printOrder.invoiceCreditNote[lang];
  }
  if (code === '9.3' && hasMovePurpose) {
    return translations.printOrder.deliveryNoteTitle[lang];
  }
  if (code === '1.1' && hasMovePurpose) {
    return translations.printOrder.invoiceDeliveryNote[lang];
  }
  if (['2.1', '2.2', '2.3'].includes(code)) {
    return translations.printOrder.serviceInvoice[lang];
  }
  return translations.printOrder.invoice[lang];
};

/**
 * Print the venue logo (dithered raster) centred.
 * Best-effort: a failed download must never block the receipt, so errors are
 * logged and swallowed.
 */
export const printLogo = async (printer, logoUrl: string) => {
  if (!logoUrl) return;
  try {
    const imageBuffer = await downloadAndProcessImage(logoUrl);
    printer.newLine();
    // printImageBuffer is async — without the await the raster bytes race the
    // rest of the receipt and can be dropped from the buffer entirely.
    await printer.printImageBuffer(imageBuffer);
    printer.alignCenter(); // raster print resets justification to left
    printer.newLine();
  } catch (error) {
    console.error(`Failed to print venue logo from ${logoUrl}:`, error);
  }
};

export const venueData = async (
  printer,
  aadeInvoice: AadeInvoice,
  issuerText: string,
  settings,
  lang: SupportedLanguages,
  venueLogoUrl = ''
) => {
  printer.alignCenter();
  if (issuerText) {
    await readMarkdown(issuerText, printer, 'center', settings, true);
  } else {
    // The logo sits between the document title and the issuer details. It is
    // deliberately skipped when issuerText is set: that markdown replaces the
    // whole header and may already carry its own <img>, so printing both would
    // duplicate the logo.
    if (settings?.printVenueLogo) {
      await printLogo(printer, venueLogoUrl);
    }
    printer.println(tr(aadeInvoice?.issuer.name, settings.transliterate));
    printer.println(tr(aadeInvoice?.issuer.activity, settings.transliterate));
    const issuerAddress = aadeInvoice?.issuer.address;
    const issuerStreetAddress = [issuerAddress?.street, issuerAddress?.number]
      .filter(Boolean)
      .join(' ');
    const issuerCityPostalCode = [
      issuerAddress?.city,
      issuerAddress?.postal_code ? `ΤΚ:${issuerAddress.postal_code}` : '',
    ]
      .filter(Boolean)
      .join(', ');

    printer.println(
      tr(
        [issuerStreetAddress, issuerCityPostalCode].filter(Boolean).join(' '),
        settings.transliterate
      )
    );

    printer.println(
      tr(
        `${translations.printOrder.taxNumber[lang]}: ${aadeInvoice?.issuer.vat_number} - ${translations.printOrder.taxOffice[lang]}: ${aadeInvoice?.issuer.tax_office}`,
        settings.transliterate
      )
    );
    printer.println(
      tr(
        `${translations.printOrder.deliveryPhone[lang]}: ${aadeInvoice?.issuer.phone}`,
        settings.transliterate
      )
    );
  }
};

export const receiptData = (
  printer,
  aadeInvoice: AadeInvoice,
  settings,
  orderNumber: number,
  orderType: string,
  lang: SupportedLanguages,
  project: string = 'centrix',
  order?: any
) => {
  printer.alignLeft();
  const rawDate = new Date(aadeInvoice?.issue_date);
  const day = rawDate.getDate();
  const month = rawDate.getMonth() + 1;
  const year = rawDate.getFullYear();
  const hours = rawDate.getHours().toString().padStart(2, '0');
  const minutes = rawDate.getMinutes().toString().padStart(2, '0');

  const formattedDate = `${day}/${month}/${year}`;
  const formattedTime = `${hours}:${minutes}`;

  printer.newLine();
  if (settings.textOptions.includes('BOLD_ORDER_NUMBER')) {
    printer.setTextSize(1, 0);
  }

  printer.setTextSize(0, 0);

  printer.println(
    tr(
      `${translations.printOrder.series[lang]}: ${aadeInvoice?.header.series.code}     ${translations.printOrder.number[lang]}: ${aadeInvoice?.header.serial_number}   ${formattedDate},${formattedTime}`,
      settings.transliterate
    )
  );

  // For invoice-delivery-notes (1.1/9.3 + move_purpose) also show the
  // dispatch purpose code, e.g. "ΣΚ. ΔΙΑΚ/ΣΗΣ: 1"
  if (aadeInvoice?.move_purpose?.code) {
    printer.println(
      tr(
        `${translations.printOrder.movePurposeAbbr[lang]}: ${aadeInvoice.move_purpose.code}`,
        settings.transliterate
      )
    );
  }

  printer.alignLeft();
  if (orderType !== 'MYPELATES') {
    if (lang === 'el') {
      if (orderType.toLowerCase() !== 'generic') {
        const serviceLabel = SERVICES[orderType.toLowerCase()]?.label_el;

        const externalOrderId = ['efoodOrderId', 'woltOrderId', 'boxOrderId']
          .map((key) => order?.[key])
          .find(Boolean);

        const tableNumbersStr =
          orderType === 'DINE_IN' &&
          Array.isArray(order?.tableNumbers) &&
          order.tableNumbers.length > 0
            ? `, ${order.tableNumbers.join(', ')}`
            : '';
        printer.println(
          tr(
            `${project.toUpperCase()}: #${orderNumber}, ${serviceLabel}${tableNumbersStr}${externalOrderId ? `: #${externalOrderId}` : ''}`,
            settings.transliterate
          )
        );
      } else {
        printer.println(`#${orderNumber}`);
      }
    } else {
      if (orderType.toLowerCase() !== 'generic') {
        const tableNumbersStr =
          orderType === 'DINE_IN' &&
          Array.isArray(order?.tableNumbers) &&
          order.tableNumbers.length > 0
            ? `, ${order.tableNumbers.join(', ')}`
            : '';
        printer.println(
          `#${orderNumber}, ${SERVICES[orderType.toLowerCase()]?.label_en}${tableNumbersStr}`
        );
      } else {
        printer.println(`#${orderNumber}`);
      }
    }
  }
};

/**
 * Print products for delivery note with columns on single line:
 * ΠΕΡΙΓΡ | ΜΜ | Ν | ΑΡΧ | ΕΚΠ | ΚΑΘ | Φ% | ΦΠΑ | ΤΕΛ
 */
export const printDeliveryNoteProducts = (
  printer,
  aadeInvoice: AadeInvoice,
  lang: SupportedLanguages,
  transliterate: boolean = false
): [number, number, any[], number, number, number] => {
  let sumAmount = 0;
  let sumQuantity = 0;
  let totalOriginalValue = 0;
  let totalNetValue = 0;
  let totalVatAmount = 0;

  printer.alignCenter();
  printer.newLine();
  printer.alignLeft();

  // Compact header - all on one line (42 chars)
  // ΠΕΡΙΓΡΑΦΗ(14) ΜΜ(4) Ν(2) ΑΡ(4) ΕΚ(3) ΚΑΘ(4) Φ%(3) ΦΠΑ(4) ΤΕ(4) = 42
  printer.println(
    'ΠΕΡΙΓΡΑΦΗ'.padEnd(14) +
      'ΜΜ'.padEnd(4) +
      'ΠΟΣ'.padEnd(2) +
      'ΑΡ'.padStart(4) +
      'ΕΚ'.padStart(3) +
      'ΚΑΘ'.padStart(4) +
      'Φ%'.padStart(3) +
      'ΦΠΑ'.padStart(4) +
      'ΤΕ'.padStart(4)
  );
  drawLine2(printer);

  const vatBreakdown = new Map();

  aadeInvoice?.details.forEach((detail: any) => {
    sumQuantity += detail.quantity;

    const name = tr(normalizeGreek(detail.name.toUpperCase()), transliterate);
    const quantity = detail.quantity.toFixed(0);

    // Map unit code to Greek unit name
    const unitMap: Record<string, string> = {
      '1': 'ΤΕΜ',
      '2': 'ΚΙΛΑ',
      '3': 'ΛΙΤΡΑ',
    };
    const unit = unitMap[detail?.unit?.code] || 'ΤΕΜ';

    // Calculate values
    const netValue = detail.net_value || 0;
    const vatAmount = detail?.tax?.value || 0;
    const finalPrice = netValue + vatAmount;
    const discount = detail?.discount || 0;
    const originalValue = netValue + discount;
    const vatRate = Number(detail.tax?.rate || 0);

    sumAmount += finalPrice;
    totalOriginalValue += originalValue;
    totalNetValue += netValue;
    totalVatAmount += vatAmount;

    // Update VAT breakdown
    if (vatBreakdown.has(vatRate)) {
      const entry = vatBreakdown.get(vatRate);
      entry.total += finalPrice;
      entry.netValue += netValue;
      entry.vatAmount += vatAmount;
    } else {
      vatBreakdown.set(vatRate, {
        vat: vatRate,
        total: finalPrice,
        netValue: netValue,
        vatAmount: vatAmount,
      });
    }

    const maxNameLength = 10;
    const truncatedName =
      name.length > maxNameLength ? name.substring(0, maxNameLength) : name;

    // Format values compactly (no decimals if .00, otherwise 1 decimal)
    const fmtVal = (v: number) => {
      if (v === 0) return '0';
      return v % 1 === 0 ? v.toFixed(0) : v.toFixed(2);
    };

    // Single line per product - matching header widths
    // name(14) + unit(4) + qty(2) + orig(4) + disc(3) + net(4) + vat%(3) + vat(4) + final(4) = 42
    printer.println(
      truncatedName.padEnd(14) +
        unit.padEnd(5) +
        quantity.padEnd(2) +
        fmtVal(originalValue).padStart(4) +
        fmtVal(discount).padStart(3) +
        fmtVal(netValue).padStart(4) +
        (vatRate + '%').padStart(3) +
        fmtVal(vatAmount).padStart(4) +
        fmtVal(finalPrice).padStart(4)
    );

    // Print remaining name on next line if truncated
    if (name.length > maxNameLength) {
      for (let i = maxNameLength; i < name.length; i += 42) {
        const chunk = name.substring(i, i + 42);
        printer.println(chunk);
      }
    }
  });

  drawLine2(printer);
  if (aadeInvoice?.comments) {
    printer.println(`ΠΑΡΑΤΗΡΗΣΕΙΣ: ${aadeInvoice?.comments}`);
    drawLine2(printer);
  }

  const fixedBreakdown = [...vatBreakdown.values()].map((entry) => ({
    ...entry,
    vatAmount: Number(entry.vatAmount.toFixed(2)),
    netValue: Number(entry.netValue.toFixed(2)),
    total: Number(entry.total.toFixed(2)),
  }));

  return [
    sumAmount,
    sumQuantity,
    fixedBreakdown,
    totalOriginalValue,
    totalNetValue,
    totalVatAmount,
  ];
};

/**
 * Print VAT breakdown for delivery note with fixed columns: 24%, 13%, 6%, 0%
 * Shows: Καθαρή Αξία, Αξία ΦΠΑ, Συνολική αξία for each rate
 * Also prints summary: ΑΡΧ. ΑΞΙΑ, ΚΑΘ. ΑΞΙΑ, ΦΠΑ, ΤΕΛ. ΤΙΜΗ
 */
export const printDeliveryNoteVatBreakdown = (
  printer,
  vatBreakdown: any[],
  lang: SupportedLanguages,
  totalOriginalValue: number,
  totalNetValue: number,
  totalVatAmount: number,
  totalFinalPrice: number
) => {
  // Create a map with all VAT rates initialized to 0
  const vatRates = [24, 13, 6, 0];
  const vatMap = new Map<
    number,
    { netValue: number; vatAmount: number; total: number }
  >();

  // Initialize all rates with 0
  vatRates.forEach((rate) => {
    vatMap.set(rate, { netValue: 0, vatAmount: 0, total: 0 });
  });

  // Fill in actual values from breakdown
  vatBreakdown.forEach((entry) => {
    if (vatMap.has(entry.vat)) {
      vatMap.set(entry.vat, {
        netValue: entry.netValue,
        vatAmount: entry.vatAmount,
        total: entry.total,
      });
    }
  });

  printer.newLine();

  // VAT Analysis Header
  printer.println(
    'ΑΝΑΛΥΣΗ ΦΠΑ'.padEnd(12) +
      '24%'.padStart(7) +
      '13%'.padStart(7) +
      '6%'.padStart(7) +
      '0%'.padStart(7)
  );
  drawLine2(printer);

  // Row 1: Καθαρή Αξία (Net Value)
  const net24 = vatMap.get(24)?.netValue.toFixed(2) || '0.00';
  const net13 = vatMap.get(13)?.netValue.toFixed(2) || '0.00';
  const net6 = vatMap.get(6)?.netValue.toFixed(2) || '0.00';
  const net0 = vatMap.get(0)?.netValue.toFixed(2) || '0.00';
  printer.println(
    'ΚΑΘΑΡΗ ΑΞΙΑ'.padEnd(12) +
      net24.padStart(7) +
      net13.padStart(7) +
      net6.padStart(7) +
      net0.padStart(7)
  );

  // Row 2: Αξία ΦΠΑ (VAT Amount)
  const vat24 = vatMap.get(24)?.vatAmount.toFixed(2) || '0.00';
  const vat13 = vatMap.get(13)?.vatAmount.toFixed(2) || '0.00';
  const vat6 = vatMap.get(6)?.vatAmount.toFixed(2) || '0.00';
  const vat0 = vatMap.get(0)?.vatAmount.toFixed(2) || '0.00';
  printer.println(
    'ΑΞΙΑ ΦΠΑ'.padEnd(12) +
      vat24.padStart(7) +
      vat13.padStart(7) +
      vat6.padStart(7) +
      vat0.padStart(7)
  );

  // Row 3: Συνολική αξία (Total)
  const tot24 = vatMap.get(24)?.total.toFixed(2) || '0.00';
  const tot13 = vatMap.get(13)?.total.toFixed(2) || '0.00';
  const tot6 = vatMap.get(6)?.total.toFixed(2) || '0.00';
  const tot0 = vatMap.get(0)?.total.toFixed(2) || '0.00';
  printer.println(
    'ΣΥΝΟΛ. ΑΞΙΑ'.padEnd(12) +
      tot24.padStart(7) +
      tot13.padStart(7) +
      tot6.padStart(7) +
      tot0.padStart(7)
  );

  drawLine2(printer);

  // Summary section
  printer.newLine();
  const lineWidth = 42;

  const summaryLines = [
    { label: 'ΑΡΧ. ΑΞΙΑ', value: totalOriginalValue.toFixed(2) + '€' },
    { label: 'ΚΑΘ. ΑΞΙΑ', value: totalNetValue.toFixed(2) + '€' },
    { label: 'ΦΠΑ', value: totalVatAmount.toFixed(2) + '€' },
    { label: 'ΤΕΛ. ΤΙΜΗ', value: totalFinalPrice.toFixed(2) + '€' },
  ];

  summaryLines.forEach((line) => {
    const spacing = lineWidth - line.label.length - line.value.length;
    printer.println(line.label + ' '.repeat(Math.max(1, spacing)) + line.value);
  });

  drawLine2(printer);
};
