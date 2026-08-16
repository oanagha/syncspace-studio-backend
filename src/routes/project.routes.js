const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const { requireWorkspaceMember } = require('../middleware/requireWorkspaceMember');
const {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
} = require('../controllers/project.controller');
const { listTasks, createTask } = require('../controllers/task.controller');

const router = Router();

router.use(authMiddleware);

router.post('/', requireWorkspaceMember, createProject);
router.get('/', requireWorkspaceMember, listProjects);
router.get('/:id/tasks', listTasks);
router.post('/:id/tasks', createTask);
router.put('/:id', updateProject);
router.delete('/:id', deleteProject);
router.get('/:id', getProject);

module.exports = router;
