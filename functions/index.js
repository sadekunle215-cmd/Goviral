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

const KUDISMS_USERNAME = process.env.KUDISMS_USERNAME;
const KUDISMS_PASSWORD = process.env.KUDISMS_PASSWORD;
const KUDISMS_SENDER   = ''; // Empty = numeric sender, no approval needed

const VTPASS_API_KEY    = process.env.VTPASS_API_KEY;
const VTPASS_PUBLIC_KEY = process.env.VTPASS_PUBLIC_KEY;
const VTPASS_SECRET_KEY = process.env.VTPASS_SECRET_KEY;
const VTPASS_BASE_URL   = process.env.VTPASS_ENV === 'live'
  ? 'https://api-service.vtpass.com/api'
  : 'https://sandbox.vtpass.com/api';

const PEYFLEX_TOKEN   = process.env.PEYFLEX_TOKEN;
const PEYFLEX_BASE    = 'https://client.peyflex.com.ng';

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  next();
});

// ── PEYFLEX HELPER ──────────────────────────────────────────────

async function peyflexGet(path) {
  const res = await fetch(`${PEYFLEX_BASE}${path}`, {
    headers: { 'Authorization': `Token ${PEYFLEX_TOKEN}`, 'Content-Type': 'application/json' }
  });
  return res.json();
}

async function peyflexPost(path, body) {
  const res = await fetch(`${PEYFLEX_BASE}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Token ${PEYFLEX_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// ── PEYFLEX WALLET BALANCE ──────────────────────────────────────

app.get('/peyflex/balance', async (req, res) => {
  try {
    const data = await peyflexGet('/api/wallet/');
    res.json({ success: true, balance: data.wallet_credit, data });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── PEYFLEX AIRTIME ─────────────────────────────────────────────

app.get('/peyflex/airtime/networks', async (req, res) => {
  try {
    const data = await peyflexGet('/api/airtime/networks/');
    res.json({ success: true, networks: data.networks || [] });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/peyflex/airtime', async (req, res) => {
  const { network, amount, mobile_number, userId, userName } = req.body;
  if (!network || !amount || !mobile_number || !userId) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }
  try {
    const data = await peyflexPost('/api/airtime/topup/', { network, amount, mobile_number });
    await db.collection('goviral_airtime_orders').add({
      userId, userName, phone: mobile_number, amount, network,
      provider: 'peyflex', type: 'airtime',
      status: data.status === 'SUCCESS' ? 'success' : 'failed',
      providerResponse: JSON.stringify(data).substring(0, 500),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (data.status === 'SUCCESS') {
      res.json({ success: true, message: 'Airtime sent successfully!', data });
    } else {
      res.status(400).json({ success: false, error: data.message || 'Airtime failed', data });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── PEYFLEX DATA ────────────────────────────────────────────────

app.get('/peyflex/data/plans', async (req, res) => {
  const { network } = req.query;
  if (!network) return res.status(400).json({ success: false, error: 'network required' });
  try {
    const data = await peyflexGet(`/api/data/plans/?network=${network}`);
    res.json({ success: true, plans: data.plans || [] });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/peyflex/data', async (req, res) => {
  const { network, plan_code, mobile_number, amount, userId, userName } = req.body;
  if (!network || !plan_code || !mobile_number || !userId) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }
  try {
    const data = await peyflexPost('/api/data/purchase/', { network, plan_code, mobile_number });
    await db.collection('goviral_airtime_orders').add({
      userId, userName, phone: mobile_number, amount, network, plan_code,
      provider: 'peyflex', type: 'data',
      status: data.status === 'SUCCESS' ? 'success' : 'failed',
      providerResponse: JSON.stringify(data).substring(0, 500),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (data.status === 'SUCCESS') {
      res.json({ success: true, message: 'Data purchased successfully!', data });
    } else {
      res.status(400).json({ success: false, error: data.message || 'Data purchase failed', data });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── PEYFLEX CABLE TV ────────────────────────────────────────────

app.get('/peyflex/cable/providers', async (req, res) => {
  try {
    const data = await peyflexGet('/api/cable/providers/');
    res.json({ success: true, providers: data.providers || [] });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/peyflex/cable/plans', async (req, res) => {
  const { provider } = req.query;
  if (!provider) return res.status(400).json({ success: false, error: 'provider required' });
  try {
    const data = await peyflexGet(`/api/cable/plans/${provider}/`);
    res.json({ success: true, plans: data.plans || [] });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/peyflex/cable/verify', async (req, res) => {
  const { iuc, identifier } = req.body;
  if (!iuc || !identifier) return res.status(400).json({ success: false, error: 'iuc and identifier required' });
  try {
    const data = await peyflexPost('/api/cable/verify/', { iuc, identifier });
    res.json({ success: true, data });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/peyflex/cable', async (req, res) => {
  const { identifier, plan, iuc, phone, amount, userId, userName } = req.body;
  if (!identifier || !plan || !iuc || !userId) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }
  try {
    const data = await peyflexPost('/api/cable/subscribe/', { identifier, plan, iuc, phone, amount: String(amount) });
    await db.collection('goviral_airtime_orders').add({
      userId, userName, iuc, amount, provider: identifier, plan,
      type: 'cable', providerName: 'peyflex',
      status: data.status === 'SUCCESS' ? 'success' : 'failed',
      providerResponse: JSON.stringify(data).substring(0, 500),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (data.status === 'SUCCESS') {
      res.json({ success: true, message: 'Cable TV subscription successful!', data });
    } else {
      res.status(400).json({ success: false, error: data.message || 'Cable subscription failed', data });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── PEYFLEX ELECTRICITY ─────────────────────────────────────────

app.get('/peyflex/electricity/plans', async (req, res) => {
  try {
    const data = await peyflexGet('/api/electricity/plans/?identifier=electricity');
    res.json({ success: true, plans: data.plans || [] });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/peyflex/electricity/verify', async (req, res) => {
  const { meter, plan, type } = req.query;
  if (!meter || !plan) return res.status(400).json({ success: false, error: 'meter and plan required' });
  try {
    const data = await peyflexGet(`/api/electricity/verify/?identifier=electricity&meter=${meter}&plan=${plan}&type=${type || 'prepaid'}`);
    res.json({ success: true, data });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/peyflex/electricity', async (req, res) => {
  const { meter, plan, amount, type, phone, userId, userName } = req.body;
  if (!meter || !plan || !amount || !userId) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }
  try {
    const data = await peyflexPost('/api/electricity/subscribe/', {
      identifier: 'electricity', meter, plan, amount: String(amount), type: type || 'prepaid', phone
    });
    await db.collection('goviral_airtime_orders').add({
      userId, userName, meter, amount, plan, type: 'electricity',
      provider: 'peyflex',
      status: data.status === 'SUCCESS' ? 'success' : 'failed',
      providerResponse: JSON.stringify(data).substring(0, 500),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (data.status === 'SUCCESS') {
      res.json({ success: true, message: 'Electricity recharge successful!', token: data.token || '', data });
    } else {
      res.status(400).json({ success: false, error: data.message || 'Electricity recharge failed', data });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── TERMII OTP ──────────────────────────────────────────────────

app.post('/kudismsSendOtp', async (req, res) => {
  const { phone, otp, pinId } = req.body;
  if (!phone || !otp) return res.status(400).json({ success: false, error: 'Phone and OTP required' });
  try {
    const mobile = phone.replace('+', '');
    const smsText = `Your GoViral verification code is: ${otp}. Valid for 10 minutes. Do not share.`;
    
    // Get Kudisms credentials from env
    const kudisUsername = process.env.KUDISMS_USERNAME;
    const kudisPassword = process.env.KUDISMS_PASSWORD;

    if (!kudisUsername || !kudisPassword) {
      return res.status(500).json({ success: false, error: 'SMS service not configured' });
    }

    const kudisRes = await fetch(`https://account.kudisms.net/api/?username=${encodeURIComponent(kudisUsername)}&password=${encodeURIComponent(kudisPassword)}&message=${encodeURIComponent(smsText)}&sender=&mobiles=${mobile}`);
    const kudisText = await kudisRes.text();
    console.log('Kudisms OTP response:', kudisText);

    if (kudisText.includes('1701') || kudisText.toLowerCase().includes('success') || kudisText.startsWith('1')) {
      res.json({ success: true, pinId });
    } else {
      res.status(500).json({ success: false, error: 'Failed to send SMS: ' + kudisText });
    }
  } catch(e) {
    console.error('Kudisms OTP error:', e.message);
    res.status(500).json({ success: false, error: 'SMS service unavailable' });
  }
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
    // Try Kudisms first, fallback to Termii
    const mobile = phone.replace('+', '');
    const smsText = `Your GoViral verification code is: ${otp}. Valid for 10 minutes. Do not share.`;
    
    let smsSent = false;

    // Try Kudisms
    if (KUDISMS_USERNAME && KUDISMS_PASSWORD) {
      try {
        const kudisRes = await fetch(`https://account.kudisms.net/api/?username=${encodeURIComponent(KUDISMS_USERNAME)}&password=${encodeURIComponent(KUDISMS_PASSWORD)}&message=${encodeURIComponent(smsText)}&sender=${KUDISMS_SENDER}&mobiles=${mobile}`, {
          method: 'GET'
        });
        const kudisText = await kudisRes.text();
        console.log('Kudisms response:', kudisText);
        if (kudisText.includes('1701') || kudisText.toLowerCase().includes('success') || kudisText.startsWith('1')) {
          smsSent = true;
        }
      } catch(e) {
        console.warn('Kudisms failed:', e.message);
      }
    }

    // Fallback to Termii if Kudisms failed
    if (!smsSent && TERMII_API_KEY) {
      try {
        const termiiRes = await fetch('https://v3.api.termii.com/api/sms/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: mobile,
            from: TERMII_SENDER_ID,
            sms: smsText,
            type: 'plain',
            api_key: TERMII_API_KEY,
            channel: TERMII_CHANNEL
          })
        });
        const data = await termiiRes.json();
        if (data.message_id || data.code === 'ok') smsSent = true;
      } catch(e) {
        console.warn('Termii fallback failed:', e.message);
      }
    }

    if (!smsSent) {
      res.status(500).json({ success: false, error: 'Failed to send SMS. Please try again.' });
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

app.post('/vtpass/balance', async (req, res) => {
  try {
    const response = await fetch(`${VTPASS_BASE_URL}/balance`, {
      method: 'GET',
      headers: vtpassAuth()
    });
    const text = await response.text();
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

app.post('/vtpass/variations', async (req, res) => {
  const { serviceID } = req.body;
  if (!serviceID) {
    res.status(400).json({ success: false, error: 'serviceID required' });
    return;
  }
  try {
    const response = await fetch(`${VTPASS_BASE_URL}/service-variations?serviceID=${serviceID}`, {
      met
