import { Router } from 'express';

import { WebhookController } from '../controllers/webhook.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const webhookRouter = Router();

webhookRouter.post('/', authMiddleware, (req, res, next) => {
  WebhookController.createWebhook(req, res).catch(next);
});

webhookRouter.get('/', authMiddleware, (req, res, next) => {
  WebhookController.listWebhooks(req, res).catch(next);
});

webhookRouter.delete('/:id', authMiddleware, (req, res, next) => {
  WebhookController.deleteWebhook(req, res).catch(next);
});

webhookRouter.patch('/:id/toggle', authMiddleware, (req, res, next) => {
  WebhookController.toggleWebhook(req, res).catch(next);
});

webhookRouter.post('/:id/test', authMiddleware, (req, res, next) => {
  WebhookController.testWebhook(req, res).catch(next);
});

webhookRouter.get('/:id/deliveries', authMiddleware, (req, res, next) => {
  WebhookController.getDeliveries(req, res).catch(next);
});

export default webhookRouter;
