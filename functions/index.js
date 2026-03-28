const { onCall, onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();

// ─────────────────────────────────────────────
//  initiateTransfer — called from admin panel
// ─────────────────────────────────────────────
exports.initiateTransfer = onCall({ enforceAppCheck: false }, async (req) => {
  if (!req.auth) throw new Error("Unauthenticated");

  const { withdrawalId } = req.data;
  if (!withdrawalId) throw new Error("Missing withdrawalId");

  const wRef = db.collection("goviral_withdrawals").doc(withdrawalId);
  const wSnap = await wRef.get();
  if (!wSnap.exists) throw new Error("Withdrawal not found");

  const w = wSnap.data();
  if (w.status !== "pending") throw new Error("Already processed");

  // Get Paystack secret key safely on the server
  const keySnap = await db.collection("goviral_settings").doc("paystack").get();
  const secretKey = keySnap.data()?.secretKey;
  if (!secretKey?.startsWith("sk_")) throw new Error("Paystack secret key not configured");

  // Mark as processing
  await wRef.update({ status: "processing", startedAt: FieldValue.serverTimestamp() });

  // Step 1: Create transfer recipient
  const recipRes = await fetch("https://api.paystack.co/transferrecipient", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
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
    await wRef.update({
      status: "failed",
      failReason: recipData.message || "Could not create recipient",
    });
    // Refund the user's balance
    const balField = w.type === "campaign" ? "campaignWallet" : "earnings";
    await db.collection("goviral_users").doc(w.uid).update({
      [balField]: FieldValue.increment(w.amount),
    });
    throw new Error(recipData.message || "Could not create recipient");
  }

  const reference = `GOVIRAL_${withdrawalId}_${Date.now()}`;

  // Step 2: Initiate the transfer (will be PENDING — not success yet)
  const txRes = await fetch("https://api.paystack.co/transfer", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "balance",
      amount: w.amount * 100, // Paystack uses kobo
      recipient: recipData.data.recipient_code,
      reference,
      reason: `GoViral payout — ${w.name}`,
    }),
  });

  const txData = await txRes.json();

  if (!txData.status) {
    await wRef.update({
      status: "failed",
      failReason: txData.message || "Transfer initiation failed",
    });
    // Refund the user's balance
    const balField = w.type === "campaign" ? "campaignWallet" : "earnings";
    await db.collection("goviral_users").doc(w.uid).update({
      [balField]: FieldValue.increment(w.amount),
    });
    throw new Error(txData.message || "Transfer failed");
  }

  // Save reference so webhook can match it
  await wRef.update({
    status: "processing",
    paystackReference: reference,
    paystackTransferCode: txData.data?.transfer_code,
    paystackStatus: txData.data?.status,
  });

  return { ok: true, transfer_code: txData.data?.transfer_code };
});

// ─────────────────────────────────────────────
//  paystackWebhook — Paystack calls this URL
//  when a transfer actually succeeds or fails
// ─────────────────────────────────────────────
exports.paystackWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") return res.sendStatus(405);

  // Verify the webhook is really from Paystack
  const keySnap = await db.collection("goviral_settings").doc("paystack").get();
  const secretKey = keySnap.data()?.secretKey;

  const hash = crypto
    .createHmac("sha512", secretKey)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    console.error("Invalid Paystack webhook signature");
    return res.status(401).send("Invalid signature");
  }

  const event = req.body;
  console.log("Paystack event received:", event.event);

  if (event.event === "transfer.success" || event.event === "transfer.failed") {
    const reference = event.data?.reference;
    if (!reference) return res.sendStatus(200);

    // Find the withdrawal with this reference
    const snap = await db
      .collection("goviral_withdrawals")
      .where("paystackReference", "==", reference)
      .limit(1)
      .get();

    if (!snap.empty) {
      const docRef = snap.docs[0].ref;
      const w = snap.docs[0].data();
      const isPaid = event.event === "transfer.success";

      // Update the withdrawal status — THIS is the real confirmation
      await docRef.update({
        status: isPaid ? "paid" : "failed",
        failReason: isPaid ? null : (event.data?.reason || "Transfer failed"),
        processedAt: FieldValue.serverTimestamp(),
        paystackStatus: event.data?.status,
      });

      // If failed, refund the user
      if (!isPaid) {
        const balField = w.type === "campaign" ? "campaignWallet" : "earnings";
        await db.collection("goviral_users").doc(w.uid).update({
          [balField]: FieldValue.increment(w.amount),
        });
      }

      // Notify the user ONLY after real confirmation
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

      console.log(`Withdrawal ${snap.docs[0].id} marked as ${isPaid ? "paid" : "failed"}`);
    }
  }

  return res.sendStatus(200);
});
