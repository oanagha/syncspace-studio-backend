const { Router } = require('express');
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth.middleware');
const {
  listFiles,
  getFile,
  uploadFile,
  downloadFile,
  deleteFile,
} = require('../controllers/file.controller');
const { getMaxUploadBytes, isAllowedFile } = require('../services/storage.service');

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getMaxUploadBytes() },
  fileFilter(_req, file, cb) {
    if (!isAllowedFile(file)) {
      cb(new Error('INVALID_FILE'));
      return;
    }
    cb(null, true);
  },
});

function handleMulter(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'File exceeds the maximum allowed size' });
      }
      return res.status(400).json({ message: 'Invalid file request' });
    }
    if (err.message === 'INVALID_FILE') {
      return res.status(400).json({ message: 'File type is not allowed' });
    }
    console.error('Multer error:', err);
    return res.status(500).json({ message: 'Failed to process file' });
  });
}

router.use(authMiddleware);
router.get('/', listFiles);
router.post('/', handleMulter, uploadFile);
router.get('/:id/download', downloadFile);
router.get('/:id', getFile);
router.delete('/:id', deleteFile);

module.exports = router;
