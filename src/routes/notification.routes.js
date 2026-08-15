const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const { listNotifications } = require('../controllers/notification.controller');

const router = Router();

router.use(authMiddleware);
router.get('/', listNotifications);

module.exports = router;
