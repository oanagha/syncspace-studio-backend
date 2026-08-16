const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const {
  listColumns,
  createColumn,
  updateColumn,
  reorderColumns,
  deleteColumn,
} = require('../controllers/column.controller');

const router = Router();

router.use(authMiddleware);
router.get('/', listColumns);
router.post('/', createColumn);
router.patch('/reorder', reorderColumns);
router.put('/:id', updateColumn);
router.delete('/:id', deleteColumn);

module.exports = router;
