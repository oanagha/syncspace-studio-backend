const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const { getBoard } = require('../controllers/board.controller');

const router = Router();

router.use(authMiddleware);
router.get('/:projectId', getBoard);

module.exports = router;
