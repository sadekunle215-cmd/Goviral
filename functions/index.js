const express = require("express");
const crypto = require("crypto");
const cors = require("cors");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const app = express();

// ── Firebase Admin init ──
let db;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : undefined;

  initializeApp(serviceAccount ? { credential: cert(serviceAccount) } : undefined);
  db = getFirestore();
  console.log("Firebase connected ✅");
} catch (e) {
  console.error("Firebase init error:", e.message);
}

// ── Middleware ──
app.use(cors({ origin: "*" }));
// Raw body needed for Paystack webhook signature check
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ── Health check ──
app.get("/", (req, res) => res.send("GoViral server running ✅"));

// ────────────────────────────────────────────────
//  POST /initiate-transfer
//  Called from adminPayNow in index.html
// ────────────────────────────────────────────────
app.post("/initiate-transfer", async (req, res) => {
  try {
    const { withdrawalId, adminSecret } = req.body;

    // Basic auth — set ADMIN_SECRET in Render environment variables
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (!withdrawalId) return res.status(400).json({ ok: false, error: "Missing withdrawalId" });

    const wRef = db.collection("goviral_withdrawals").doc(withdrawalId);
    const wSnap = await wRef.get();
    if (!wSnap.exists) return res.status(404).json({ ok: false, error: "Withdrawal not found" });

    const w = wSnap.data();
    if (w.status !== "pending") return res.status(400).json({ ok: false, error: "Already processed" });

    // Get Paystack secret key from Firestore (safe — server side only)
    const keySnap = await db.collection("goviral_settings").doc("paystack").get();
    const secretKey = keySnap.data()?.secretKey;
    if (!secretKey?.startsWith("sk_")) {
      return res.status(500).json({ ok: false, error: "Paystack secret key not configured" });
    }

    // Mark as processing
    await wRef.update({ status: "processing", startedAt: FieldValue.serverTimestamp() });

    // Step 1: Create transfer recipient
    const recipRes = await fetch("https://api.paystack.co/transferrecipient", {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "nuban",
        name: w.accName,
        account_number: w.accNo,
        bank_code: w.bankCode,
        currency: "NGN",
      }),
    });
    const recipData = await recipRes.json();

    if (!recipData.status || !recipData.data?.recipient_code) {
      await wRef.update({ status: "failed", failReason: recipData.message || "Could not create recipient" });
      const balField = w.type === "campaign" ? "campaignWallet" : "earnings";
      await db.collection("goviral_users").doc(w.uid).update({ [balField]: FieldValue.increment(w.amount) });
      return res.status(500).json({ ok: false, error: recipData.message || "Could not create recipient" });
    }

    const reference = `GOVIRAL_${withdrawalId}_${Date.now()}`;

    // Step 2: Initiate transfer — Paystack returns "pending", NOT "success" yet
    const txRes = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "balance",
        amount: w.amount * 100,
        recipient: recipData.data.recipient_code,
        reference,
        reason: `GoViral payout — ${w.name}`,
      }),
    });
    const txData = await txRes.json();

    if (!txData.status) {
      await wRef.update({ status: "failed", failReason: txData.message || "Transfer failed" });
      const balField = w.type === "campaign" ? "campaignWallet" : "earnings";
      await db.collection("goviral_users").doc(w.uid).update({ [balField]: FieldValue.increment(w.amount) });
      return res.status(500).json({ ok: false, error: txData.message || "Transfer failed" });
    }

    // Save reference so webhook can match it later
    await wRef.update({
      status: "processing",
      paystackReference: reference,
      paystackTransferCode: txData.data?.transfer_code,
      paystackStatus: txData.data?.status,
    });

    return res.json({ ok: true, transfer_code: txData.data?.transfer_code });
  } catch (e) {
    console.error("initiateTransfer error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ────────────────────────────────────────────────
//  POST /paystack-webhook
//  Paystack calls this when transfer settles
//  Set this URL in Paystack Dashboard → Settings → Webhooks
// ────────────────────────────────────────────────
app.post("/paystack-webhook", async (req, res) => {
  try {
    const keySnap = await db.collection("goviral_settings").doc("paystack").get();
    const secretKey = keySnap.data()?.secretKey;

    const rawBody = req.body;
    const hash = crypto
      .createHmac("sha512", secretKey)
      .update(rawBody)
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      console.error("Invalid webhook signature");
      return res.status(401).send("Invalid signature");
    }

    const event = JSON.parse(rawBody.toString());
    console.log("Paystack webhook:", event.event);

    if (event.event === "transfer.success" || event.event === "transfer.failed") {
      const reference = event.data?.reference;
      if (!reference) return res.sendStatus(200);

      const snap = await db
        .collection("goviral_withdrawals")
        .where("paystackReference", "==", reference)
        .limit(1)
        .get();

      if (!snap.empty) {
        const docRef = snap.docs[0].ref;
        const w = snap.docs[0].data();
        const isPaid = event.event === "transfer.success";

        await docRef.update({
          status: isPaid ? "paid" : "failed",
          failReason: isPaid ? null : (event.data?.reason || "Transfer failed"),
          processedAt: FieldValue.serverTimestamp(),
          paystackStatus: event.data?.status,
        });

        if (!isPaid) {
          const balField = w.type === "campaign" ? "campaignWallet" : "earnings";
          await db.collection("goviral_users").doc(w.uid).update({
            [balField]: FieldValue.increment(w.amount),
          });
        }

        await db.collection("goviral_notifications").add({
          uid: w.uid,
          icon: isPaid ? "💸" : "❌",
          title: isPaid ? "Payment Sent! ✅" : "Payment Failed ❌",
          message: isPaid
            ? `₦${w.amount.toLocaleString()} has been sent to your ${w.bank} account (${w.accNo}).`
            : `Your withdrawal of ₦${w.amount.toLocaleString()} failed. Your balance has been refunded.`,
          createdAt: FieldValue.serverTimestamp(),
          read: false,
        });

        console.log(`Withdrawal ${snap.docs[0].id} → ${isPaid ? "paid ✅" : "failed ❌"}`);
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(500);
  }
});

// ── Ping (keep-alive) ──
app.get("/ping", (req, res) => res.json({ ok: true, time: Date.now() }));

// ────────────────────────────────────────────────
//  PEYFLEX HELPERS
// ────────────────────────────────────────────────
const PEYFLEX_BASE = "https://api.peyflex.com";
let _peyflexToken = null;
let _peyflexTokenExpiry = 0;

async function getPeyflexToken() {
  if (_peyflexToken && Date.now() < _peyflexTokenExpiry) return _peyflexToken;

  const keySnap = await db.collection("goviral_settings").doc("api_keys").get();
  const keys = keySnap.data() || {};
  const email = keys.peyflex_email;
  const password = keys.peyflex_password;

  if (!email || !password) throw new Error("Peyflex credentials not configured in admin settings.");

  const res = await fetch(`${PEYFLEX_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();

  if (!data.token && !data.access_token && !data.data?.token) {
    throw new Error(data.message || "Peyflex login failed.");
  }

  _peyflexToken = data.token || data.access_token || data.data?.token;
  _peyflexTokenExpiry = Date.now() + 55 * 60 * 1000; // cache 55 mins
  return _peyflexToken;
}

async function peyflexRequest(method, path, body = null) {
  const token = await getPeyflexToken();
  const opts = {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${PEYFLEX_BASE}${path}`, opts);
  const data = await res.json();
  // If token expired, clear cache and retry once
  if ((data.message || "").toLowerCase().includes("unauthenticated") ||
      (data.message || "").toLowerCase().includes("unauthorized")) {
    _peyflexToken = null;
    const token2 = await getPeyflexToken();
    opts.headers.Authorization = `Bearer ${token2}`;
    const res2 = await fetch(`${PEYFLEX_BASE}${path}`, opts);
    return res2.json();
  }
  return data;
}

// Save order to Firestore
async function saveVtuOrder(userId, orderData) {
  try {
    await db.collection("goviral_airtime_orders").add({
      uid: userId,
      ...orderData,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error("saveVtuOrder error:", e.message);
  }
}

// ────────────────────────────────────────────────
//  GET /peyflex/data/plans?network=mtn_gifting_data
// ────────────────────────────────────────────────
app.get("/peyflex/data/plans", async (req, res) => {
  try {
    const { network } = req.query;
    if (!network) return res.status(400).json({ success: false, error: "network required" });
    const data = await peyflexRequest("GET", `/data/plans?network=${network}`);
    const plans = data.plans || data.data || data.bundles || [];
    return res.json({ success: true, plans });
  } catch (e) {
    console.error("peyflex/data/plans error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ────────────────────────────────────────────────
//  POST /peyflex/airtime
// ────────────────────────────────────────────────
app.post("/peyflex/airtime", async (req, res) => {
  try {
    const { network, amount, mobile_number, userId, userName } = req.body;
    if (!network || !amount || !mobile_number) {
      return res.status(400).json({ success: false, error: "network, amount, mobile_number required" });
    }
    const data = await peyflexRequest("POST", "/airtime", {
      network, amount: Number(amount), mobile_number,
    });
    const ok = data.success || data.status === "success" || data.data?.status === "success";
    await saveVtuOrder(userId, {
      type: "airtime", network, phone: mobile_number,
      amount: Number(amount), status: ok ? "success" : "failed",
      peyflexRef: data.reference || data.data?.reference || null,
      userName: userName || "",
    });
    if (ok) return res.json({ success: true, message: data.message || "Airtime sent." });
    return res.status(200).json({ success: false, error: data.message || "Airtime failed." });
  } catch (e) {
    console.error("peyflex/airtime error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ────────────────────────────────────────────────
//  POST /peyflex/data
// ────────────────────────────────────────────────
app.post("/peyflex/data", async (req, res) => {
  try {
    const { network, plan_code, mobile_number, amount, userId, userName } = req.body;
    if (!network || !plan_code || !mobile_number) {
      return res.status(400).json({ success: false, error: "network, plan_code, mobile_number required" });
    }
    const data = await peyflexRequest("POST", "/data", {
      network, plan_code, mobile_number, amount: Number(amount),
    });
    const ok = data.success || data.status === "success" || data.data?.status === "success";
    await saveVtuOrder(userId, {
      type: "data", network, phone: mobile_number, planLabel: plan_code,
      amount: Number(amount), status: ok ? "success" : "failed",
      peyflexRef: data.reference || data.data?.reference || null,
      userName: userName || "",
    });
    if (ok) return res.json({ success: true, message: data.message || "Data sent." });
    return res.status(200).json({ success: false, error: data.message || "Data purchase failed." });
  } catch (e) {
    console.error("peyflex/data error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ────────────────────────────────────────────────
//  GET /peyflex/cable/plans?provider=dstv
// ────────────────────────────────────────────────
app.get("/peyflex/cable/plans", async (req, res) => {
  try {
    const { provider } = req.query;
    if (!provider) return res.status(400).json({ success: false, error: "provider required" });
    const data = await peyflexRequest("GET", `/cable/plans?provider=${provider}`);
    const plans = data.plans || data.data || data.packages || [];
    return res.json({ success: true, plans });
  } catch (e) {
    console.error("peyflex/cable/plans error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ────────────────────────────────────────────────
//  POST /peyflex/cable/verify  { iuc, identifier }
// ────────────────────────────────────────────────
app.post("/peyflex/cable/verify", async (req, res) => {
  try {
    const { iuc, identifier } = req.body;
    if (!iuc || !identifier) return res.status(400).json({ success: false, error: "iuc and identifier required" });
    const data = await peyflexRequest("POST", "/cable/verify", { iuc, identifier });
    const ok = data.success || data.status === "success" || !!data.data?.name;
    return res.json({ success: ok, name: data.data?.name || data.name || "", message: data.message || "" });
  } catch (e) {
    console.error("peyflex/cable/verify error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ────────────────────────────────────────────────
//  POST /peyflex/cable
// ────────────────────────────────────────────────
app.post("/peyflex/cable", async (req, res) => {
  try {
    const { identifier, plan, iuc, phone, amount, userId, userName } = req.body;
    if (!identifier || !plan || !iuc) {
      return res.status(400).json({ success: false, error: "identifier, plan, iuc required" });
    }
    const data = await peyflexRequest("POST", "/cable", {
      identifier, plan, iuc, phone, amount: Number(amount),
    });
    const ok = data.success || data.status === "success" || data.data?.status === "success";
    await saveVtuOrder(userId, {
      type: "cable", provider: identifier, iuc, phone: phone || "",
      planLabel: plan, amount: Number(amount), status: ok ? "success" : "failed",
      peyflexRef: data.reference || data.data?.reference || null,
      userName: userName || "",
    });
    if (ok) return res.json({ success: true, message: data.message || "Cable subscribed." });
    return res.status(200).json({ success: false, error: data.message || "Cable subscription failed." });
  } catch (e) {
    console.error("peyflex/cable error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ────────────────────────────────────────────────
//  GET /peyflex/electricity/verify?meter=&plan=&type=
// ────────────────────────────────────────────────
app.get("/peyflex/electricity/verify", async (req, res) => {
  try {
    const { meter, plan, type } = req.query;
    if (!meter || !plan) return res.status(400).json({ success: false, error: "meter and plan required" });
    const data = await peyflexRequest("GET", `/electricity/verify?meter=${meter}&plan=${plan}&type=${type || "prepaid"}`);
    const ok = data.success || data.status === "success" || !!data.data?.name;
    return res.json({ success: ok, name: data.data?.name || data.name || "", address: data.data?.address || "", message: data.message || "" });
  } catch (e) {
    console.error("peyflex/electricity/verify error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ────────────────────────────────────────────────
//  POST /peyflex/electricity
// ────────────────────────────────────────────────
app.post("/peyflex/electricity", async (req, res) => {
  try {
    const { meter, plan, amount, type, phone, userId, userName } = req.body;
    if (!meter || !plan || !amount) {
      return res.status(400).json({ success: false, error: "meter, plan, amount required" });
    }
    const data = await peyflexRequest("POST", "/electricity", {
      meter, plan, amount: Number(amount), type: type || "prepaid", phone,
    });
    const ok = data.success || data.status === "success" || data.data?.status === "success";
    const token = data.token || data.data?.token || null;
    await saveVtuOrder(userId, {
      type: "electricity", meter, phone: phone || "", provider: plan,
      amount: Number(amount), status: ok ? "success" : "failed", token,
      peyflexRef: data.reference || data.data?.reference || null,
      userName: userName || "",
    });
    if (ok) return res.json({ success: true, token, message: data.message || "Electricity payment successful." });
    return res.status(200).json({ success: false, error: data.message || "Electricity payment failed." });
  } catch (e) {
    console.error("peyflex/electricity error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── Start server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GoViral server running on port ${PORT}`));
