const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const {
  inviteMember,
  listInvitations,
  listMyInvitations,
  listMembers,
  updateMemberRole,
  removeMember,
  acceptInvitation,
  cancelInvitation,
} = require('../controllers/team.controller');

const router = Router();

router.use(authMiddleware);
router.get('/', listMembers);
router.post('/invite', inviteMember);
router.get('/invites/mine', listMyInvitations);
router.get('/invites', listInvitations);
router.post('/invites/:id/accept', acceptInvitation);
router.delete('/invites/:id', cancelInvitation);
router.patch('/:userId', updateMemberRole);
router.delete('/:userId', removeMember);

module.exports = router;
