const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const { updateTask } = require('../controllers/task.controller');

const router = Router();

router.use(authMiddleware);
router.put('/:id', updateTask);

module.exports = router;
