const { Router } = require('express');
const { submitContact } = require('../controllers/contact.controller');

const router = Router();

router.post('/', submitContact);

module.exports = router;
