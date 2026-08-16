const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../controllers/notification.controller');

const router = Router();

router.use(authMiddleware);
router.get('/', listNotifications);
router.post('/read-all', markAllNotificationsRead);
router.patch('/:id/read', markNotificationRead);

module.exports = router;
