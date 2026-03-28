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

// ── Start server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GoViral server running on port ${PORT}`));
