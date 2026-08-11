const { Router } = require('express');
const {
  register,
  login,
  forgotPassword,
  verifyOtp,
  resetPassword,
} = require('../controllers/auth.controller');

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/verify-otp', verifyOtp);
router.post('/reset-password', resetPassword);

module.exports = router;
