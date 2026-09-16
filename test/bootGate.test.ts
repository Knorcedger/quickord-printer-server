import { Request, Response } from 'express';

import {
  bootGate,
  markFirstPoll,
  startBootGate,
} from '../src/modules/bootGate';

const call = () => {
  const next = jest.fn();
  const res = {
    send: jest.fn(),
    status: jest.fn().mockReturnThis(),
  };
  bootGate({} as Request, res as unknown as Response, next);
  return { next, res };
};

describe('boot gate', () => {
  afterEach(() => jest.restoreAllMocks());

  it('answers 503 before the first poll', () => {
    startBootGate();

    const { next, res } = call();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).toHaveBeenCalledWith({ status: 'starting' });
  });

  it('counts the window from startup, not from process start', () => {
    // 20s of auto-update and printer setup before the server listens: the
    // window must still be ahead of the first request, not already spent.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000);
    startBootGate();

    const { next, res } = call();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('opens after 15s even with no poll, so the LAN fallback still works', () => {
    startBootGate();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_000);

    expect(call().next).toHaveBeenCalled();
  });

  it('opens on the first successful poll', () => {
    markFirstPoll();

    expect(call().next).toHaveBeenCalled();
  });
});
