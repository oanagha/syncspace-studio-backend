const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  switchWorkspace,
  renameWorkspace,
  deleteWorkspace,
} = require('../controllers/workspace.controller');

const router = Router();

router.use(authMiddleware);

router.post('/', createWorkspace);
router.get('/', listWorkspaces);
router.post('/switch', switchWorkspace);
router.put('/:id', renameWorkspace);
router.delete('/:id', deleteWorkspace);
router.get('/:id', getWorkspace);

module.exports = router;
