import { Router } from 'express';

import { AdminController } from '../controllers/admin.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import { sensitiveRateLimiter } from '../middleware/rate-limit.middleware';

/**
 * Admin Dashboard Routes
 * Platform management endpoints. All routes require an authenticated ADMIN user.
 */
const adminRouter = Router();

adminRouter.use(authMiddleware, adminMiddleware, sensitiveRateLimiter);

// User management
adminRouter.get('/users', (req, res, next) => {
  AdminController.listUsers(req, res).catch(next);
});

adminRouter.get('/users/:id', (req, res, next) => {
  AdminController.getUser(req, res).catch(next);
});

adminRouter.put('/users/:id/status', (req, res, next) => {
  AdminController.updateUserStatus(req, res).catch(next);
});

adminRouter.get('/users/:id/activity', (req, res, next) => {
  AdminController.getUserActivity(req, res).catch(next);
});

// Transaction monitoring — static paths before parameterized routes
adminRouter.get('/transactions/alerts', (req, res, next) => {
  AdminController.getTransactionAlerts(req, res).catch(next);
});

adminRouter.get('/transactions', (req, res, next) => {
  AdminController.listTransactions(req, res).catch(next);
});

adminRouter.get('/transactions/:id', (req, res, next) => {
  AdminController.getTransaction(req, res).catch(next);
});

adminRouter.post('/transactions/:id/flag', (req, res, next) => {
  AdminController.flagTransaction(req, res).catch(next);
});

// Compliance
adminRouter.get('/compliance/alerts', (req, res, next) => {
  AdminController.listComplianceAlerts(req, res).catch(next);
});

adminRouter.put('/compliance/alerts/:id', (req, res, next) => {
  AdminController.resolveComplianceAlert(req, res).catch(next);
});

adminRouter.get('/compliance/reports', (req, res, next) => {
  AdminController.getComplianceReports(req, res).catch(next);
});

// System health & observability
adminRouter.get('/health', (req, res, next) => {
  AdminController.getSystemHealth(req, res).catch(next);
});

adminRouter.get('/metrics', (req, res, next) => {
  AdminController.getMetrics(req, res).catch(next);
});

adminRouter.get('/logs', (req, res, next) => {
  AdminController.getLogs(req, res).catch(next);
});

// Configuration — static /config/audit before generic /config handlers
adminRouter.get('/config/audit', (req, res, next) => {
  AdminController.getConfigAudit(req, res).catch(next);
});

adminRouter.get('/config', (req, res, next) => {
  AdminController.getConfig(req, res).catch(next);
});

adminRouter.put('/config', (req, res, next) => {
  AdminController.updateConfig(req, res).catch(next);
});

export default adminRouter;
