import { Request, Response } from 'express';
import { CharacterSet } from 'node-thermal-printer';
import { z } from 'zod';

import logger from '../modules/logger';
import { printTestPage } from '../modules/printer';


const testPrint = async (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    let ip = '';
    let port = '';
    if (req.body.ip !== '') {
      ip = z.string().ip().parse(req.body.ip.replace('\r', ''));
      logger.info('Printing test page for ip printer:', ip);
    }
    if (req.body.port !== '') {
      port = req.body.port;
      logger.info('Printing test page for usb printer:', port);
    }
    const charset = z.nativeEnum(CharacterSet).parse(req.body.charset);
    const codePage = req.body.codePage;

    await printTestPage(ip, port, charset, codePage);

    res.status(200).send({ status: 'done' });
  } catch (error) {
    logger.error('Error printing test page:', error);
    res.status(500).send({ error: error instanceof Error ? error.message : 'Print failed' });
  }
};

export default testPrint;
