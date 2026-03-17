const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const TERMII_API_KEY   = 'TLDAzOlApNnxpDRkUDJVXdXIsaExlpqYqqYVOpRzVbfopJpFrxAieEUDwMOIne';
const TERMII_SENDER_ID = 'N-Alert';
const TERMII_CHANNEL   = 'generic';
const OTP_TTL_MS       = 10 * 60 * 1000;

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

exports.termiiSendOtp = functions.https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

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
      res.status(429).json({ success: false, error: 'Too many attempts. Wait 10 minutes and try again.' });
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
    const termiiRes = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:      phone.replace('+', ''),
        from:    TERMII_SENDER_ID,
        sms:     `Your GoViral verification code is: ${otp}. Valid for 10 minutes. Do not share this code.`,
        type:    'plain',
        api_key: TERMII_API_KEY,
        channel: TERMII_CHANNEL
      })
    });
    const termiiData = await termiiRes.json();
    if (!termiiData.message_id && termiiData.code !== 'ok') {
      console.error('[GoViral] Termii error:', JSON.stringify(termiiData));
      res.status(500).json({ success: false, error: 'Failed to send SMS. Please try again.' });
      return;
    }
    res.json({ success: true, pinId });
  } catch (e) {
    console.error('[GoViral] fetch error:', e);
    res.status(500).json({ success: false, error: 'SMS service unavailable. Try again.' });
  }
});

exports.termiiVerifyOtp = functions.https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { pinId, code } = req.body;
  if (!pinId || !code) {
    res.status(400).json({ success: false, error: 'Missing pinId or code' });
    return;
  }

  const sessionRef = db.collection('goviral_otp_sessions').doc(pinId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    res.status(400).json({ success: false, error: 'Session expired. Request a new OTP.' });
    return;
  }

  const session = sessionSnap.data();
  if (session.used) {
    res.status(400).json({ success: false, error: 'This OTP has already been used.' });
    return;
  }
  if (Date.now() > session.expiresAt) {
    await sessionRef.update({ used: true });
    res.status(400).json({ success: false, error: 'OTP expired. Request a new one.' });
    return;
  }
  if (session.otp.toString().trim() !== code.toString().trim()) {
    res.status(400).json({ success: false, error: 'Incorrect code. Try again.' });
    return;
  }

  await sessionRef.update({ used: true, verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
  res.json({ success: true, phone: session.phone });
});
