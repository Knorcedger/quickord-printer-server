import { Request, Response } from 'express';
import { z } from 'zod';

import logger from '../modules/logger.ts';
import { printOrders as printerPrintOrders } from '../modules/printer.ts';
const updateStatusEnumValues = [
  'INITIAL',
  'NEW',
  'UNCHANGED',
  'UPDATED',
] as const;
export const Product = z.object({
  _id: z.string({
    invalid_type_error: 'product _id must be a string.',
    required_error: 'product _id is required.',
  }),
  comments: z.string({
    invalid_type_error: 'comments must be a string.',
    required_error: 'comments is required.',
  }),
  categories: z.array(
    z.string({ invalid_type_error: 'categories must be an array of strings.' })
  ),
  vat: z
    .preprocess(
      (val) => {
        const num = Number(val);
        return isNaN(num) ? 0 : num;
      },
      z.number({
        invalid_type_error: 'vat must be a number.',
        required_error: 'vat is required.',
      })
    )
    .optional(),
  choices: z
    .array(
      z.object({
        price: z
          .number({
            invalid_type_error: 'choice price must be a number.',
          })
          .optional(),
        quantity: z
          .number({
            invalid_type_error: 'choice quantity must be a number.',
          })

          .optional(),
        title: z.string({
          invalid_type_error: 'choice title must be a string.',
          required_error: 'choice title is required.',
        }),
      })
    )
    .optional(),
  quantity: z.number({
    invalid_type_error: 'product quantity must be a number.',
    required_error: 'product quantity is required.',
  }),
  quantityChanged: z
    .object({
      is: z.number(),
      was: z.number(),
    })
    .optional(),
  updateStatus: z.enum(updateStatusEnumValues, {
    invalid_type_error: 'Invalid update status.',
    required_error: 'Update status is required.',
  }),
  title: z.string({
    invalid_type_error: 'product title must be a string.',
    required_error: 'product title is required.',
  }),
  total: z.number({
    invalid_type_error: 'product total must be a number.',
    required_error: 'product total is required.',
  }),
});

export const OrderType = z.enum([
  'DELIVERY',
  'DINE_IN',
  'TAKE_AWAY_INSIDE',
  'TAKE_AWAY_PACKAGE',
  'EFOOD',
  'WOLT',
  'FAGI',
  'BOX',
]);

export const PaymentType = z.enum([
  'DELIVERY_CARD',
  'DELIVERY_CASH',
  'ONLINE',
  'WAITER_CARD',
  'WAITER_CASH',
  'WAITER_CASH_AND_CARD',
]);

export const DeliveryInfo = z.object({
  customerAddress: z.string({
    invalid_type_error: 'customerAddress must be a string.',
    required_error: 'customerAddress is required.',
  }),
  customerBell: z.string({
    invalid_type_error: 'customer bell must be a string.',
    required_error: 'customerBell is required.',
  }),
  customerEmail: z
    .string({
      invalid_type_error: 'customerEmail must be a string.',
    })
    .optional()
    .nullable(),
  customerFirstname: z
    .string({
      invalid_type_error: 'customerName must be a string.',
      required_error: 'customerName is required.',
    })
    .optional(),
  customerFloor: z.string({
    invalid_type_error: 'customerFloor must be a string.',
    required_error: 'customerFloor is required.',
  }),
  customerLastname: z
    .string({
      invalid_type_error: 'customerName must be a string.',
      required_error: 'customerName is required.',
    })
    .optional(),
  customerName: z
    .string({
      invalid_type_error: 'customerName must be a string.',
      required_error: 'customerName is required.',
    })
    .optional(),
  customerPhoneNumber: z.string({
    invalid_type_error: 'customerPhoneNumber must be a string.',
    required_error: 'customerPhoneNumber is required.',
  }),
  deliveryFee: z
    .number({
      invalid_type_error: 'deliveryFee must be a number.',
    })
    .optional()
    .default(0),
});

export const TakeAwayInfo = z.object({
  customerEmail: z
    .string({
      invalid_type_error: 'customerEmail must be a string.',
    })
    .optional(),
  customerName: z
    .string({
      invalid_type_error: 'customerName must be a string.',
    })
    .optional(),
});

export const Order = z.object({
  TakeAwayInfo: TakeAwayInfo.optional(),
  _id: z.string({
    invalid_type_error: '_id must be a string.',
    required_error: '_id is required.',
  }),
  createdAt: z
    .string({
      invalid_type_error: 'Invalid date format. Please use ISO format.',
      required_error: 'createdAt is required.',
    })
    .datetime({
      message: 'Invalid date format. Please use ISO format.',
    })
    .describe('The date and time the order was created in ISO format'),
  currency: z
    .string({
      invalid_type_error: 'currency must be a string.',
    })
    .optional()
    .default('€'),
  customerComment: z
    .string({
      invalid_type_error: 'customerComment must be a string.',
    })
    .optional(),
  deliveryInfo: DeliveryInfo.optional(),
  number: z.number({
    invalid_type_error: 'number must be a number.',
    required_error: 'number is required.',
  }),
  orderType: OrderType,
  paymentType: PaymentType,
  products: z.array(Product, {
    invalid_type_error: 'products must be an array of Product objects.',
    required_error: 'products is required.',
  }),
  tableNumber: z.any({
    invalid_type_error: 'tableNumber must be a string.',
    required_error: 'tableNumber is required.',
  }),
  tip: z
    .number({
      invalid_type_error: 'tip must be a number.',
    })
    .optional(),
  total: z.number({
    invalid_type_error: 'total must be a number.',
    required_error: 'total is required.',
  }),
  venue: z.object({
    address: z
      .string({
        invalid_type_error: 'address must be a string.',
        required_error: 'address is required.',
      })
      .describe('The address of the venue in string format'),
    title: z.string({
      invalid_type_error: 'title must be a string.',
      required_error: 'title is required.',
    }),
  }),
  waiterComment: z
    .string({
      invalid_type_error: 'waiterComment must be a string.',
    })
    .optional(),
  isEdit: z
    .boolean({
      invalid_type_error: 'isEdit must be a boolean.',
      required_error: 'isEdit is required.',
    })
    .optional(),
  waiterName: z
    .string({
      invalid_type_error: 'waiterName must be a string.',
      required_error: 'waiterName is required.',
    })
    .optional(),
});

const Orders = z.array(Order);

const printOrders = (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    const orders = Orders.parse(req.body);

    logger.info('orders to print:', orders);

    printerPrintOrders(orders);
    console.log(orders[0]?.products);

    res.status(200).send({ status: 'updated' });
  } catch (error) {
    logger.error('Error printing orders:', error);
    res.status(400).send({ error: error.message });
  }
};

export default printOrders;
