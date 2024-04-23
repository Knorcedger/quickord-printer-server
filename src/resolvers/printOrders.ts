import { Request, Response } from 'express';
import { z } from 'zod';

import logger from '../modules/logger.ts';

export const Product = z.object({
  _id: z.string(),
  categories: z.array(
    z.object({
      _id: z.string(),
    })
  ),
});

export const Order = z.object({
  _id: z.string(),
  createdAt: z.string().datetime(),
  products: z.array(Product),
  venue: z.object({
    _id: z.string(),
    address: z.string(),
    title: z.string(),
  }),
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
