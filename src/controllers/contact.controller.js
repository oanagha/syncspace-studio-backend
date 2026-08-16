const { sendContactEmail } = require('../utils/mail');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 120;
const MAX_SUBJECT = 200;
const MAX_MESSAGE = 5000;

/** Simple in-memory throttle for this public endpoint only (no existing rate-limit middleware). */
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 8;
const submissionsByIp = new Map();

function clientIp(req) {
  // Do not trust X-Forwarded-For unless the process explicitly enables proxy trust.
  if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (submissionsByIp.get(ip) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    submissionsByIp.set(ip, recent);
    return true;
  }
  recent.push(now);
  submissionsByIp.set(ip, recent);
  return false;
}

function validateContactBody(body = {}) {
  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim();
  const subject = String(body.subject ?? '').trim();
  const message = String(body.message ?? '').trim();

  if (!name) return { error: 'Name is required' };
  if (name.length > MAX_NAME) return { error: 'Name is too long' };
  if (!email) return { error: 'Email is required' };
  if (!EMAIL_RE.test(email)) return { error: 'Valid email is required' };
  if (!subject) return { error: 'Subject is required' };
  if (subject.length > MAX_SUBJECT) return { error: 'Subject is too long' };
  if (!message) return { error: 'Message is required' };
  if (message.length > MAX_MESSAGE) return { error: 'Message is too long' };

  return {
    value: {
      name,
      email: email.toLowerCase(),
      subject,
      message,
    },
  };
}

async function submitContact(req, res) {
  try {
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      return res.status(429).json({
        message: 'Too many messages. Please try again later.',
      });
    }

    const { value, error } = validateContactBody(req.body);
    if (error) {
      return res.status(400).json({ message: error });
    }

    await sendContactEmail(value);

    return res.status(200).json({ message: 'Message sent' });
  } catch (err) {
    console.error('Contact form error:', err);
    return res.status(500).json({ message: 'Failed to send message' });
  }
}

module.exports = { submitContact };
