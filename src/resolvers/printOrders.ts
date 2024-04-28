import { Request, Response } from 'express';
import { z } from 'zod';

import logger from '../modules/logger.ts';

export const Product = z.object({
  _id: z.string(),
  categories: z.array(z.string()),
  choices: z.array(
    z.object({
      price: z.number().positive().optional(),
      quantity: z.number().positive().optional(),
      title: z.string(),
    })
  ),
  quantity: z.number().positive(),
  title: z.string(),
  total: z.number().positive(),
});

export const OrderType = z.enum([
  'DELIVERY',
  'DINE_IN',
  'TAKE_AWAY_INSIDE',
  'TAKE_AWAY_PACKAGE',
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
  customerAddress: z.string(),
  customerBell: z.string(),
  customerEmail: z.string(),
  customerFloor: z.string(),
  customerName: z.string(),
  customerPhoneNumber: z.string(),
  deliveryFee: z.number().positive().optional().default(0),
});

export const TakeAwayInfo = z.object({
  customerEmail: z.string().optional(),
  customerName: z.string(),
});

export const Order = z.object({
  TakeAwayInfo: TakeAwayInfo.optional(),
  _id: z.string(),
  createdAt: z.string().datetime(),
  currency: z.string(),
  customerComment: z.string().optional(),
  deliveryInfo: DeliveryInfo.optional(),
  number: z.number(),
  orderType: OrderType,
  paymentType: PaymentType,
  products: z.array(Product),
  tableNumber: z.string(),
  tip: z.number().optional(),
  total: z.number().positive(),
  venue: z.object({
    address: z.string().describe('The address of the venue in string format'),
    title: z.string(),
  }),
  waiterComment: z.string().optional(),
});

const Orders = z.array(Order);

const printOrders = (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    const newSettings = Orders.parse(req.body);

    logger.info('orders to print:', newSettings);

    res.status(200).send({ status: 'updated' });
  } catch (error) {
    logger.error('Error printing orders:', error);
    res.status(400).send({ error: error.message });
  }
};

export default printOrders;
