import { Router } from 'express';

import { NotificationController } from '../controllers/notification.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const notificationRouter = Router();

notificationRouter.use(authMiddleware);

notificationRouter.get('/', (req, res, next) => {
  NotificationController.listNotifications(req, res).catch(next);
});

notificationRouter.post('/read', (req, res, next) => {
  NotificationController.markRead(req, res).catch(next);
});

notificationRouter.get('/preferences', (req, res, next) => {
  NotificationController.getPreferences(req, res).catch(next);
});

notificationRouter.put('/preferences', (req, res, next) => {
  NotificationController.updatePreferences(req, res).catch(next);
});

notificationRouter.get('/push-subscriptions', (req, res, next) => {
  NotificationController.listPushSubscriptions(req, res).catch(next);
});

notificationRouter.post('/push-subscriptions', (req, res, next) => {
  NotificationController.registerPushSubscription(req, res).catch(next);
});

notificationRouter.delete('/push-subscriptions/:id', (req, res, next) => {
  NotificationController.deletePushSubscription(req, res).catch(next);
});

export default notificationRouter;
