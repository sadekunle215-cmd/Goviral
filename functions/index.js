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

const VTPASS_API_KEY    = process.env.VTPASS_API_KEY;
const VTPASS_PUBLIC_KEY = process.env.VTPASS_PUBLIC_KEY;
const VTPASS_SECRET_KEY = process.env.VTPASS_SECRET_KEY;
const VTPASS_BASE_URL   = process.env.VTPASS_ENV === 'live'
  ? 'https://api-service.vtpass.com/api'
  : 'https://sandbox.vtpass.com/api';

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  next();
});

// ── TERMII OTP ──────────────────────────────────────────────────

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
        to: phone.replace('+', ''),
        from: TERMII_SENDER_ID,
        sms: `Your GoViral verification code is: ${otp}. Valid for 10 minutes. Do not share.`,
        type: 'plain',
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

// ── VTPASS ──────────────────────────────────────────────────────

// Correct VTPass auth: Basic base64(publicKey:secretKey)
function vtpassAuth() {
  const credentials = Buffer.from(`${VTPASS_PUBLIC_KEY}:${VTPASS_SECRET_KEY}`).toString('base64');
  return {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json'
  };
}

function generateRequestId() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${Math.random().toString(36).slice(2,8).toUpperCase()}`;
}

// Test balance
app.post('/vtpass/balance', async (req, res) => {
  try {
    const response = await fetch(`${VTPASS_BASE_URL}/balance`, {
      method: 'GET',
      headers: vtpassAuth()
    });
    const text = await response.text();
    console.log('VTPass balance raw:', text);
    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }
    if (data?.code === '000' || data?.contents?.balance !== undefined) {
      res.json({ success: true, balance: data?.contents?.balance ?? 0, data });
    } else {
      res.json({ success: false, error: data?.response_description || text, data });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Buy airtime
app.post('/vtpass/airtime', async (req, res) => {
  const { phone, amount, network, userId, userName } = req.body;
  if (!phone || !amount || !network || !userId) {
    res.status(400).json({ success: false, error: 'Missing required fields.' });
    return;
  }
  const networkMap = { mtn:'mtn', airtel:'airtel', glo:'glo', '9mobile':'etisalat' };
  const serviceID = networkMap[network.toLowerCase()];
  if (!serviceID) {
    res.status(400).json({ success: false, error: 'Invalid network.' });
    return;
  }
  const requestId = generateRequestId();
  try {
    const response = await fetch(`${VTPASS_BASE_URL}/pay`, {
      method: 'POST',
      headers: vtpassAuth(),
      body: JSON.stringify({ request_id: requestId, serviceID, amount: String(amount), phone })
    });
    const text = await response.text();
    console.log('VTPass airtime raw:', text);
    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }

    await db.collection('goviral_airtime').add({
      userId, userName, phone, amount, network: serviceID, requestId,
      status: data?.code === '000' ? 'success' : 'failed',
      providerResponse: JSON.stringify(data).substring(0, 500),
      type: 'airtime',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (data?.code === '000') {
      res.json({ success: true, message: 'Airtime sent!', data });
    } else {
      res.status(400).json({ success: false, error: data?.response_description || 'Failed', data });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Buy data
app.post('/vtpass/data', async (req, res) => {
  const { phone, variation_code, network, userId, userName, amount } = req.body;
  if (!phone || !variation_code || !network || !userId) {
    res.status(400).json({ success: false, error: 'Missing required fields.' });
    return;
  }
  const networkMap = { mtn:'mtn-data', airtel:'airtel-data', glo:'glo-data', '9mobile':'etisalat-data' };
  const serviceID = networkMap[network.toLowerCase()];
  if (!serviceID) {
    res.status(400).json({ success: false, error: 'Invalid network.' });
    return;
  }
  const requestId = generateRequestId();
  try {
    const response = await fetch(`${VTPASS_BASE_URL}/pay`, {
      method: 'POST',
      headers: vtpassAuth(),
      body: JSON.stringify({
        request_id: requestId, serviceID,
        billersCode: phone, variation_code,
        amount: String(amount), phone
      })
    });
    const text = await response.text();
    console.log('VTPass data raw:', text);
    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }

    await db.collection('goviral_airtime').add({
      userId, userName, phone, amount, network: serviceID, variation_code, requestId,
      status: data?.code === '000' ? 'success' : 'failed',
      providerResponse: JSON.stringify(data).substring(0, 500),
      type: 'data',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (data?.code === '000') {
      res.json({ success: true, message: 'Data sent!', data });
    } else {
      res.status(400).json({ success: false, error: data?.response_description || 'Failed', data });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get data variations
app.post('/vtpass/variations', async (req, res) => {
  const { serviceID } = req.body;
  if (!serviceID) {
    res.status(400).json({ success: false, error: 'serviceID required' });
    return;
  }
  try {
    const response = await fetch(`${VTPASS_BASE_URL}/service-variations?serviceID=${serviceID}`, {
      method: 'GET',
      headers: vtpassAuth()
    });
    const data = await response.json();
    res.json({ success: true, data });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GoViral server running on port ${PORT}`));
