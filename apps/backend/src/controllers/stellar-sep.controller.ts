import type { Request, Response } from 'express';

import type { SepAuthRequest } from '../middleware/sep-auth.middleware';
import { StellarSep10Service } from '../services/stellar-sep10.service';
import { StellarSep24Service } from '../services/stellar-sep24.service';
import { AppError } from '../types';
import type {
  Sep24CompleteInteractiveRequest,
  Sep24InteractiveRequest,
  SEPSessionType,
} from '../types/sep.types';
import { SEP24_STATE_COOKIE } from '../types/sep.types';
import { handleError } from '../utils/http';
import { getSep24CookieOptions, parseCookieHeader, verifySep24State } from '../utils/sep-cookie';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readInteractiveKind(value: string): SEPSessionType {
  if (value === 'deposit' || value === 'withdraw') {
    return value;
  }
  throw new AppError(400, 'Interactive flow must be deposit or withdraw');
}

export const StellarSepController = {
  getStellarToml(_req: Request, res: Response): void {
    try {
      const toml = StellarSep10Service.getStellarToml();
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.status(200).send(toml);
    } catch (error) {
      handleError(res, error);
    }
  },

  getChallenge(req: Request, res: Response): void {
    try {
      const account = asString(req.query.account);
      if (!account) {
        throw new AppError(400, 'account is required');
      }

      const challenge = StellarSep10Service.buildChallenge(
        account,
        asString(req.query.home_domain),
        asString(req.query.web_auth_domain)
      );
      res.status(200).json(challenge);
    } catch (error) {
      handleError(res, error);
    }
  },

  async postChallenge(req: Request, res: Response): Promise<void> {
    try {
      const xdr = asString((req.body as { transaction?: unknown })?.transaction);
      if (!xdr) {
        throw new AppError(400, 'transaction is required');
      }

      const result = await StellarSep10Service.verifyChallenge(xdr);
      res.status(200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },

  getInfo(req: SepAuthRequest, res: Response): void {
    try {
      res.status(200).json(StellarSep24Service.getInfo(req.sep));
    } catch (error) {
      handleError(res, error);
    }
  },

  async startDeposit(req: SepAuthRequest, res: Response): Promise<void> {
    try {
      if (!req.sep) {
        throw new AppError(401, 'SEP-10 token is required');
      }

      const result = await StellarSep24Service.startInteractiveDeposit(
        req.sep,
        req.body as Sep24InteractiveRequest
      );
      res.cookie(SEP24_STATE_COOKIE, result.cookieValue, getSep24CookieOptions());
      res.status(200).json({
        type: result.type,
        url: result.url,
        id: result.id,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async startWithdraw(req: SepAuthRequest, res: Response): Promise<void> {
    try {
      if (!req.sep) {
        throw new AppError(401, 'SEP-10 token is required');
      }

      const result = await StellarSep24Service.startInteractiveWithdrawal(
        req.sep,
        req.body as Sep24InteractiveRequest
      );
      res.cookie(SEP24_STATE_COOKIE, result.cookieValue, getSep24CookieOptions());
      res.status(200).json({
        type: result.type,
        url: result.url,
        id: result.id,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getTransaction(req: SepAuthRequest, res: Response): Promise<void> {
    try {
      if (!req.sep) {
        throw new AppError(401, 'SEP-10 token is required');
      }

      const id = asString(req.query.id);
      const transaction = await StellarSep24Service.getTransaction(req.sep, id ?? '');
      res.status(200).json({ transaction });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getTransactions(req: SepAuthRequest, res: Response): Promise<void> {
    try {
      if (!req.sep) {
        throw new AppError(401, 'SEP-10 token is required');
      }

      const limitRaw = asString(req.query.limit);
      let limit: number | undefined;
      if (limitRaw !== undefined) {
        if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) {
          throw new AppError(400, 'limit must be a positive integer');
        }
        limit = Number(limitRaw);
      }

      const kindRaw = asString(req.query.kind);
      if (kindRaw !== undefined && kindRaw !== 'deposit' && kindRaw !== 'withdraw') {
        throw new AppError(400, 'kind must be deposit or withdraw');
      }

      const result = await StellarSep24Service.getTransactions(req.sep, {
        asset_code: asString(req.query.asset_code),
        kind: kindRaw,
        no_older_than: asString(req.query.no_older_than),
        limit,
        paging_id: asString(req.query.paging_id),
      });
      res.status(200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },

  async startInteractivePage(req: Request, res: Response): Promise<void> {
    try {
      const kind = readInteractiveKind(req.params.kind);
      const sessionId = req.params.sessionId;
      const token = asString(req.params.token);
      if (sessionId === undefined || sessionId.length === 0) {
        throw new AppError(400, 'sessionId is required');
      }
      if (token === undefined) {
        throw new AppError(401, 'Interactive session token is required');
      }

      const cookieValue = await StellarSep24Service.issueInteractiveCookie(sessionId, kind, token);
      res.cookie(SEP24_STATE_COOKIE, cookieValue, getSep24CookieOptions());
      res.redirect(302, StellarSep24Service.frontendRedirectUrl(kind, sessionId));
    } catch (error) {
      handleError(res, error);
    }
  },

  async completeInteractive(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = req.params.sessionId;
      const cookieValue = parseCookieHeader(req.headers.cookie);
      if (!cookieValue) {
        throw new AppError(401, 'Interactive session cookie is required');
      }

      const state = verifySep24State(cookieValue);
      if (state.sessionId !== sessionId) {
        throw new AppError(403, 'Interactive session cookie mismatch');
      }

      const result = await StellarSep24Service.completeInteractive(
        sessionId,
        state.clientAccount,
        req.body as Sep24CompleteInteractiveRequest
      );
      res.status(200).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
};
