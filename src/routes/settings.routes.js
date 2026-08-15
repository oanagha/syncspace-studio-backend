const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const { getPreferences, updatePreferences } = require('../controllers/settings.controller');

const router = Router();

router.use(authMiddleware);
router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);

module.exports = router;
