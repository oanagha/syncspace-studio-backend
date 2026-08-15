const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const {
  getTask,
  createTask,
  updateTask,
  assignTask,
  updateTaskPriority,
  updateTaskDueDate,
  updateTaskStatus,
  deleteTask,
} = require('../controllers/task.controller');
const { listComments, createComment } = require('../controllers/comment.controller');
const {
  listSubtasks,
  createSubtask,
  updateSubtask,
  deleteSubtask,
} = require('../controllers/subtask.controller');
const { watchTask, unwatchTask } = require('../controllers/watch.controller');

const router = Router();

router.use(authMiddleware);
router.post('/', createTask);
router.get('/:id/comments', listComments);
router.post('/:id/comments', createComment);
router.get('/:id/subtasks', listSubtasks);
router.post('/:id/subtasks', createSubtask);
router.patch('/:id/subtasks/:subtaskId', updateSubtask);
router.delete('/:id/subtasks/:subtaskId', deleteSubtask);
router.post('/:id/watch', watchTask);
router.delete('/:id/unwatch', unwatchTask);
router.get('/:id', getTask);
router.patch('/:id/assign', assignTask);
router.patch('/:id/priority', updateTaskPriority);
router.patch('/:id/due-date', updateTaskDueDate);
router.patch('/:id/status', updateTaskStatus);
router.put('/:id', updateTask);
router.delete('/:id', deleteTask);

module.exports = router;
