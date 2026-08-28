import { Request, Response } from 'express';
import { z } from 'zod';

import logger from '../modules/logger';
import {
  printOrdersComments as printerPrintOrdersComments,
  determinePrintStatus,
  buildPrintResponse,
} from '../modules/printer';
import { OrderType } from './printOrders';

export const OrderComments = z.object({
  _id: z.string(),
  createdAt: z.string().datetime(),
  customerComment: z.string().optional(),
  number: z.number(),
  orderType: OrderType,
  tableNumber: z.any().optional(),
  tableNumbers: z.array(z.any()).optional(),
  venue: z.object({
    address: z.string(),
    title: z.string(),
  }),
  waiterComment: z.string().optional(),
});

const Orders = z.array(OrderComments);

const printOrderComments = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    const orders = Orders.parse(req.body);

    logger.info('orders to print (comments only):', orders);

    const result = await printerPrintOrdersComments(orders);

    const { httpCode } = determinePrintStatus(
      result.successes,
      result.errors,
      result.skipped
    );

    res.status(httpCode).send(buildPrintResponse(result));
  } catch (error) {
    logger.error('Error printing order comments:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(500).send({ error: errorMessage });
  }
};

export default printOrderComments;
