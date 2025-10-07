import { transliterate } from 'transliteration';
import {
  CharacterSet,
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import { IPrinterSettings, ISettings, PrinterTextSize } from './settings';
import { date, z } from 'zod';
import { DEFAULT_CODE_PAGE, changeCodePage } from './printer';
import { SupportedLanguages, translations } from './translations';
export const leftPad = (str: string, length: number, char = ' ') => {
  return str.padStart(length, char);
};
import { AadeInvoice } from './interfaces';
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

const PaymentMethodDescriptions = Object.freeze(
  Object.fromEntries(
    Object.values(PaymentMethod).map(({ description, value }) => [
      value,
      description,
    ])
  )
);

export const readMarkdown = (text, printer, alignment, settings) => {
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
      // Check for tags
      const tagMatch = text.slice(index).match(/^<(\/?)(b|u|s1|s2|s3|s4)>/);
      if (tagMatch) {
        // Print current buffer before changing formatting
        if (buffer) {
          changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
          printer.bold(formatting.bold);
          printer.underline(formatting.underline);
          printer.print(buffer);
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
          changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
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
      changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
      printer.bold(formatting.bold);
      printer.underline(formatting.underline);
      printer.println(buffer);
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
    changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
    printer.bold(formatting.bold);

    printer.underline(formatting.underline);
    printer.print(buffer);
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
  efood: {
    value: 'efood',
    label_en: 'EFOOD',
    label_el: 'EFOOD',
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
  dine_in: {
    value: 'dineIn',
    label_en: 'DINE IN',
    label_el: 'DINE IN',
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

export const printMarks = (printer, aadeInvoice, lang) => {
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
  printer.println(
    `${translations.printOrder.provider[lang]} www.invoiceportal.gr`
  );
  printer.newLine();
};
export const printPayments = (printer, aadeInvoice, lang) => {
  printer.bold(false);
  printer.alignCenter();
  drawLine2(printer);
  printer.println(`${translations.printOrder.payments[lang]}:`);
  aadeInvoice?.payment_methods.forEach((detail: any) => {
    console.log(detail.code);
    if (detail.amount > 0) {
      const methodDescription =
        PaymentMethod[detail.code]?.description ||
        translations.printOrder.unknown[lang];
      printer.println(
        `${methodDescription}     ${translations.printOrder.amount[lang]}: ${detail.amount.toFixed(2)}€`
      );
    }
    drawLine2(printer);
  });
};

export const printProducts = (
  printer,
  aadeInvoice,
  order,
  settings,
  lang
): [number, number, any[]] => {
  let sumAmount = 0;
  let sumQuantity = 0;
  printer.alignCenter();
  printer.newLine();
  printer.alignLeft();
  printer.println(
    `${translations.printOrder.quantity[lang]}`.padEnd(7) +
      `${translations.printOrder.kind[lang]}`.padEnd(20) +
      `${translations.printOrder.price[lang]}`.padEnd(10) +
      `${translations.printOrder.vat[lang]}`
  );
  drawLine2(printer);
  const vatBreakdown = new Map();
  aadeInvoice?.details.forEach((detail: any) => {
    sumQuantity += detail.quantity;

    const name = detail.name.toUpperCase();
    console.log('proion', detail.name, lang);
    // First, find the product that contains the matchedContent

    const quantity = detail.quantity.toFixed(0); // "1,000"
    const value = (
      (detail.net_value || 0) + (detail?.tax?.value || 0)
    )?.toFixed(2);
    const vat = `${detail.tax.rate}%`; // "24%"
    sumAmount += parseFloat(value);
    const maxNameLength = 17;
    const vatRate = Number(detail.tax.rate); // ensure number

    const netValue = detail.net_value;
    const total = parseFloat(value);

    if (vatBreakdown.has(vatRate)) {
      const entry = vatBreakdown.get(vatRate);
      entry.total += total;
      entry.netValue += netValue;
      entry.vatAmount = entry.total - entry.netValue; // update VAT
    } else {
      vatBreakdown.set(vatRate, {
        vat: vatRate,
        total,
        netValue,
        vatAmount: total - netValue,
      });
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
              value.padEnd(7) +
              vat
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
          value.padStart(7) +
          vat.padStart(10)
      );
    }
    const matchedProduct = order.products?.find((p: any) =>
      p.content?.some(
        (c: any) => c.language === lang && c.title === detail.name
      )
    );
    const getTitle = (content, lang) => {
      return (
        content.find((c) => c.language === lang)?.title ||
        content.find((c) => c.language === 'en')?.title ||
        ''
      );
    };

    if (matchedProduct) {
      console.log('Matched product:', matchedProduct);

      // Print the product title (from matchedContent)
      const matchedContent = matchedProduct.content.find(
        (c: any) => c.language === lang && c.title === detail.name
      );

      const lineWidth = 32;
      // Then loop through its choices (options)
      matchedProduct.options?.forEach((choice: any) => {
        console.log('choice', choice);
        choice.choices.forEach((ch) => {
          const choiceTitle = getTitle(choice.content, lang); // parent title
          const quantityPrefix =
            Number(ch.quantity) > 1 ? `${ch.quantity}x ` : '';

          // Build main text
          const choiceText = `- ${quantityPrefix}${choiceTitle}`;

          // Price (only if > 0)
          const choicePrice =
            ch.price && ch.price > 0 ? `${(ch.price / 100).toFixed(2)} €` : '';

          // Add indentation at start (e.g., 5 spaces)
          const indent = '     '; // 5 spaces
          const paddedChoiceLine =
            indent + choiceText + (choicePrice ? '   ' + choicePrice : '');

          printer.println(paddedChoiceLine);
          console.log('choice', paddedChoiceLine);
        });
      });
    }
  });

  drawLine2(printer);
  const fixedBreakdown = [...vatBreakdown.values()].map((entry) => ({
    ...entry,
    vatAmount: Number((entry.total - entry.netValue).toFixed(2)),
  }));
  console.log(fixedBreakdown);

  return [sumAmount, sumQuantity, fixedBreakdown];
};

export const printDiscountAndTip = (printer, discount, tip, lang) => {
  let discountAmount = '';
  if ('amount' in discount && 'type' in discount) {
    if (discount.type === 'FIXED') {
      discountAmount = (discount.amount / 100).toString() + '€';
    } else {
      discountAmount = discount.amount.toString() + '%';
    }
    if (discountAmount !== '') {
      printer.println(
        `${translations.printOrder.discount[lang]}: ${discountAmount},${DISCOUNTTYPES[discount.type.toLocaleLowerCase()]?.label_el || ''}`
      );
    }
    if (tip > 0) {
      printer.println(
        `${translations.printOrder.tip[lang]}: ${(tip / 100).toFixed(2)}€`
      );
    }
  }
};

export const printVatBreakdown = (printer, vatBreakdown, lang) => {
  printer.println(
    `${translations.printOrder.percentage[lang].padEnd(10)}${translations.printOrder.netWorth[lang].padEnd(12)}${translations.printOrder.netValue[lang].padEnd(10)}${translations.printOrder.total[lang].padStart(10)}`
  );

  vatBreakdown.forEach((entry) => {
    printer.println(
      `${String(entry.vat).padEnd(10)}${String(entry.netValue.toFixed(2)).padEnd(12)}${String(entry.vatAmount.toFixed(2)).padEnd(10)}${String(entry.total.toFixed(2)).padStart(10)}`
    );
  });

  drawLine2(printer);
};
export const venueData = (
  printer,
  aadeInvoice: AadeInvoice,
  issuerText: string,
  settings,
  lang: SupportedLanguages
) => {
  printer.alignCenter();
  if (issuerText) {
    readMarkdown(issuerText, printer, 'center', settings);
  } else {
    printer.println(aadeInvoice?.issuer.name);
    printer.println(aadeInvoice?.issuer.activity);
    printer.println(
      `${aadeInvoice?.issuer.address.street} ${aadeInvoice?.issuer.address.city}, τκ:${aadeInvoice?.issuer.address.postal_code}`
    );

    printer.println(
      `${translations.printOrder.taxNumber[lang]}: ${aadeInvoice?.issuer.vat_number} - ${translations.printOrder.taxOffice[lang]}: ${aadeInvoice?.issuer.tax_office}`
    );
    printer.println(
      `${translations.printOrder.deliveryPhone[lang]}: ${aadeInvoice?.issuer.phone}`
    );
  }
};

export const receiptData = (
  printer,
  aadeInvoice: AadeInvoice,
  settings,
  orderNumber: number,
  orderType: string,
  lang: SupportedLanguages
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
    `${translations.printOrder.series[lang]}: ${aadeInvoice?.header.series.code}     ${translations.printOrder.number[lang]}: ${aadeInvoice?.header.serial_number}   ${formattedDate},${formattedTime}`
  );

  printer.alignLeft();
  if (orderType !== 'MYPELATES') {
    if (lang === 'el') {
      if (orderType.toLowerCase() !== 'generic') {
        printer.println(
          `#${orderNumber}, ${SERVICES[orderType.toLowerCase()]?.label_el}`
        );
      } else {
        printer.println(`#${orderNumber}`);
      }
    } else {
      if (orderType.toLowerCase() !== 'generic') {
        printer.println(
          `#${orderNumber}, ${SERVICES[orderType.toLowerCase()]?.label_en}`
        );
      } else {
        printer.println(`#${orderNumber}`);
      }
    }
  }
};
