import { Request, Response } from 'express';
import { CharacterSet } from 'node-thermal-printer';
import { z } from 'zod';

import logger from '../modules/logger.ts';
import { printTestPage } from '../modules/printer.ts';

const testPrint = (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    const ip = z.string().ip().parse(req.body.ip.replace('\r', ''));
    const charset = z.nativeEnum(CharacterSet).parse(req.body.charset);

    logger.info('Printing test page for:', ip);
    printTestPage(ip, charset);

    res.status(200).send({ status: 'done' });
  } catch (error) {
    logger.error('Error printing test page:', error);
    res.status(400).send(error.message);
  }
};

export default testPrint;
