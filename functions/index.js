const express = require('express');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TERMII_API_KEY   = process.env.TERMII_API_KEY;
const TERMII_SENDER_ID = 'N-Alert';
const TERMII_CHANNEL   = 'generic';
const OTP_TTL_MS       = 10 * 60 * 1000;

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  next();
});

app.post('/termiiSendOtp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\+\d{10,15}$/.test(phone)) {
    res.status(400).json({ success: false, error: 'Invalid phone number. Use +234XXXXXXXXXX' });
    return;
  }

  const rateLimitRef = db.collection('goviral_otp_ratelimit').doc(phone.replace('+', ''));
  const rlSnap = await rateLimitRef.get();
  if (rlSnap.exists) {
    const rl = rlSnap.data();
    const windowStart = Date.now() - OTP_TTL_MS;
    const recentAttempts = (rl.attempts || []).filter(ts => ts > windowStart);
    if (recentAttempts.length >= 3) {
      res.status(429).json({ success: false, error: 'Too many attempts. Wait 10 minutes.' });
      return;
    }
    await rateLimitRef.update({ attempts: [...recentAttempts, Date.now()] });
  } else {
    await rateLimitRef.set({ attempts: [Date.now()] });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const pinId = `gv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = Date.now() + OTP_TTL_MS;

  await db.collection('goviral_otp_sessions').doc(pinId).set({
    phone, otp, expiresAt, used: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  try {
    const termiiRes = await fetch('https://v3.api.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:      phone.replace('+', ''),
        from:    TERMII_SENDER_ID,
        sms:     `Your GoViral verification code is: ${otp}. Valid for 10 minutes. Do not share.`,
        type:    'plain',
        api_key: TERMII_API_KEY,
        channel: TERMII_CHANNEL
      })
    });
    const data = await termiiRes.json();
    if (!data.message_id && data.code !== 'ok') {
      res.status(500).json({ success: false, error: 'Failed to send SMS.' });
      return;
    }
    res.json({ success: true, pinId });
  } catch (e) {
    res.status(500).json({ success: false, error: 'SMS service unavailable.' });
  }
});

app.post('/termiiVerifyOtp', async (req, res) => {
  const { pinId, code } = req.body;
  if (!pinId || !code) {
    res.status(400).json({ success: false, error: 'Missing pinId or code' });
    return;
  }

  const sessionRef = db.collection('goviral_otp_sessions').doc(pinId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    res.status(400).json({ success: false, error: 'Session expired. Request new OTP.' });
    return;
  }

  const session = sessionSnap.data();
  if (session.used) {
    res.status(400).json({ success: false, error: 'OTP already used.' });
    return;
  }
  if (Date.now() > session.expiresAt) {
    await sessionRef.update({ used: true });
    res.status(400).json({ success: false, error: 'OTP expired. Request new one.' });
    return;
  }
  if (session.otp.toString().trim() !== code.toString().trim()) {
    res.status(400).json({ success: false, error: 'Incorrect code. Try again.' });
    return;
  }

  await sessionRef.update({ used: true, verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
  res.json({ success: true, phone: session.phone });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GoViral OTP server running on port ${PORT}`));
