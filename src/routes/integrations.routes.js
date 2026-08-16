const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const {
  listIntegrations,
  startConnect,
  handleCallback,
  disconnect,
} = require('../controllers/integrations.controller');

const router = Router();

router.get('/:provider/callback', handleCallback);
router.use(authMiddleware);
router.get('/', listIntegrations);
router.post('/:provider/connect', startConnect);
router.delete('/:provider', disconnect);

module.exports = router;
