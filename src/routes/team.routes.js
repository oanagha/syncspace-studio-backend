const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const { inviteMember, listInvitations, listMembers } = require('../controllers/team.controller');

const router = Router();

router.use(authMiddleware);
router.get('/', listMembers);
router.post('/invite', inviteMember);
router.get('/invites', listInvitations);

module.exports = router;
