"use strict";

const { sendEmail } = require("../../../utils/sendEmail");
const runtime = require("./shared/runtime");

const logger = runtime?.logger || console;

const {
  initiatedSenderTemplate,
  initiatedReceiverTemplate,
  confirmedSenderTemplate,
  confirmedReceiverTemplate,
  cancelledSenderTemplate,
  cancelledReceiverTemplate,
} = require("../../../utils/transactionEmailTemplates");

function safeString(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function safeAmount(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildBaseData(data = {}) {
  return {
    transactionId: safeString(data.transactionId),
    reference: safeString(data.reference),
    amount: safeAmount(data.amount, 0),
    currency: safeString(data.currency, "XOF"),
    date: safeString(data.dateIso, new Date().toISOString()),
    senderEmail: safeString(data.senderEmail),
    receiverEmail: safeString(data.receiverEmail),
    senderName: safeString(data.senderName, safeString(data.senderEmail, "Expéditeur")),
    receiverName: safeString(data.receiverName, safeString(data.receiverEmail, "Destinataire")),
    reason: safeString(data.reason),
  };
}

function buildFallbackHtml({ subject, status, data }) {
  const reference = safeString(data?.reference);
  const amount = safeAmount(data?.amount, 0);
  const currency = safeString(data?.currency, "XOF");

  return `
    <html>
      <body style="font-family:Arial,Helvetica,sans-serif;background:#f7f7f7;padding:24px;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e5e7eb;">
          <h2 style="margin:0 0 16px 0;color:#111827;">${subject}</h2>
          <p style="margin:0 0 12px 0;color:#374151;">Le statut de votre transaction est maintenant : <strong>${safeString(status, "updated")}</strong>.</p>
          <p style="margin:0 0 8px 0;color:#374151;">Référence : <strong>${reference}</strong></p>
          <p style="margin:0;color:#374151;">Montant : <strong>${amount} ${currency}</strong></p>
        </div>
      </body>
    </html>
  `;
}

function buildEmailContent({ role, status, data = {} }) {
  const base = buildBaseData(data);

  let subject = "PayNoval — Notification transaction";
  let html = "";

  if (status === "initiated") {
    if (role === "sender") {
      subject = "✅ PayNoval — Votre transaction a été initiée";
      html = initiatedSenderTemplate({
        ...base,
        name: base.senderName,
      });
    } else {
      subject = "💸 PayNoval — Nouvelle transaction en attente de validation";
      html = initiatedReceiverTemplate({
        ...base,
        name: base.receiverName,
      });
    }
  } else if (status === "confirmed") {
    if (role === "sender") {
      subject = "✅ PayNoval — Transaction confirmée";
      html = confirmedSenderTemplate({
        ...base,
        name: base.senderName,
      });
    } else {
      subject = "✅ PayNoval — Transaction reçue";
      html = confirmedReceiverTemplate({
        ...base,
        name: base.receiverName,
      });
    }
  } else if (status === "cancelled") {
    if (role === "sender") {
      subject = "❌ PayNoval — Transaction annulée";
      html = cancelledSenderTemplate({
        ...base,
        name: base.senderName,
        reason: base.reason || "",
      });
    } else {
      subject = "❌ PayNoval — Transaction annulée";
      html = cancelledReceiverTemplate({
        ...base,
        name: base.receiverName,
        reason: base.reason || "",
      });
    }
  } else {
    subject = `PayNoval — Mise à jour transaction ${base.reference || ""}`.trim();
    html = buildFallbackHtml({ subject, status, data: base });
  }

  return {
    subject,
    html,
    text: `${subject}\nRéférence: ${base.reference || ""}\nMontant: ${base.amount} ${base.currency}\nStatut: ${safeString(status, "updated")}`,
  };
}

async function sendTransactionEmail({ user, role, status, data = {} }) {
  try {
    if (!user?.email) {
      return { ok: false, reason: "USER_EMAIL_MISSING" };
    }

    const { subject, html, text } = buildEmailContent({
      user,
      role,
      status,
      data,
    });

    await sendEmail({
      to: user.email,
      subject,
      html,
      text,
    });

    return { ok: true };
  } catch (err) {
    logger?.error?.(
      {
        err: err?.message || err,
        email: user?.email || null,
        role,
        status,
      },
      "[transactionEmailService] sendTransactionEmail failed"
    );

    return {
      ok: false,
      reason: err?.message || "TX_EMAIL_SEND_FAILED",
    };
  }
}

module.exports = {
  sendTransactionEmail,
};