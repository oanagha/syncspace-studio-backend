const { Router } = require('express');
const {
  register,
  login,
  verify2fa,
  get2faStatus,
  setup2fa,
  enable2fa,
  disable2fa,
  forgotPassword,
  verifyOtp,
  resetPassword,
} = require('../controllers/auth.controller');
const { authMiddleware } = require('../middleware/auth.middleware');

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/verify-2fa', verify2fa);
router.get('/2fa/status', authMiddleware, get2faStatus);
router.post('/2fa/setup', authMiddleware, setup2fa);
router.post('/2fa/enable', authMiddleware, enable2fa);
router.post('/2fa/disable', authMiddleware, disable2fa);
router.post('/forgot-password', forgotPassword);
router.post('/verify-otp', verifyOtp);
router.post('/reset-password', resetPassword);

module.exports = router;
