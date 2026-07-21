import { Router } from 'express';

import { WebhookController } from '../controllers/webhook.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { sensitiveRateLimiter } from '../middleware/rate-limit.middleware';

const webhookRouter = Router();

webhookRouter.use(authMiddleware, sensitiveRateLimiter);

webhookRouter.post('/', (req, res, next) => {
  WebhookController.createWebhook(req, res).catch(next);
});

webhookRouter.get('/', (req, res, next) => {
  WebhookController.listWebhooks(req, res).catch(next);
});

webhookRouter.delete('/:id', (req, res, next) => {
  WebhookController.deleteWebhook(req, res).catch(next);
});

webhookRouter.patch('/:id/toggle', (req, res, next) => {
  WebhookController.toggleWebhook(req, res).catch(next);
});

webhookRouter.post('/:id/test', (req, res, next) => {
  WebhookController.testWebhook(req, res).catch(next);
});

webhookRouter.get('/:id/deliveries', (req, res, next) => {
  WebhookController.getDeliveries(req, res).catch(next);
});

export default webhookRouter;
