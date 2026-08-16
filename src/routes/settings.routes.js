const { Router } = require('express');
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth.middleware');
const {
  getPreferences,
  updatePreferences,
  uploadAvatar,
  removeAvatar,
} = require('../controllers/settings.controller');
const {
  getAvatarMaxBytes,
  isAllowedAvatar,
} = require('../services/storage.service');

const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getAvatarMaxBytes() },
  fileFilter(_req, file, cb) {
    if (!isAllowedAvatar(file)) {
      cb(new Error('INVALID_AVATAR'));
      return;
    }
    cb(null, true);
  },
});

function handleAvatarMulter(req, res, next) {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'Avatar must be 2 MB or smaller' });
      }
      return res.status(400).json({ message: 'Invalid avatar upload' });
    }
    if (err.message === 'INVALID_AVATAR') {
      return res.status(400).json({ message: 'Avatar must be a PNG, JPEG, or WebP image' });
    }
    console.error('Avatar multer error:', err);
    return res.status(500).json({ message: 'Failed to process avatar' });
  });
}

router.use(authMiddleware);
router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);
router.post('/avatar', handleAvatarMulter, uploadAvatar);
router.delete('/avatar', removeAvatar);

module.exports = router;
