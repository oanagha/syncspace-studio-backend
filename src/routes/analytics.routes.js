const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const { getDashboard } = require('../controllers/analytics.controller');

const router = Router();

router.use(authMiddleware);
router.get('/dashboard', getDashboard);

module.exports = router;
