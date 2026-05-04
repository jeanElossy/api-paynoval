// "use strict";

// const createError = require("http-errors");

// const {
//   Transaction,
//   startTxSession,
//   maybeSessionOpts,
//   CAN_USE_SHARED_SESSION,
// } = require("../shared/runtime");

// const { resolveExecutor } = require("../providers/providerExecutorRegistry");

// async function submitExternalExecution({ req, transactionId }) {
//   const session = await startTxSession();

//   try {
//     if (CAN_USE_SHARED_SESSION) session.startTransaction();

//     const sessOpts = maybeSessionOpts(session);

//     const tx = await Transaction.findById(transactionId).session(sessOpts.session || null);
//     if (!tx) {
//       throw createError(404, "Transaction introuvable");
//     }

//     const resolved = resolveExecutor({
//       flow: tx.flow,
//       provider: tx.provider,
//     });

//     if (!resolved || typeof resolved.execute !== "function") {
//       throw createError(400, `Aucun executor trouvé pour le flow ${tx.flow}`);
//     }

//     if (!tx.provider && resolved.provider) {
//       tx.provider = resolved.provider;
//     }

//     const result = await resolved.execute({
//       req,
//       transaction: tx,
//     });

//     tx.providerStatus =
//       result?.providerStatus ||
//       tx.providerStatus ||
//       "PROVIDER_SUBMITTED";

//     tx.providerReference =
//       result?.providerReference ||
//       tx.providerReference ||
//       null;

//     if (tx.status === "pending") {
//       tx.status = "processing";
//     }

//     tx.metadata = {
//       ...(tx.metadata || {}),
//       execution: {
//         ...(tx.metadata?.execution || {}),
//         submittedAt: new Date().toISOString(),
//         resolvedProvider: resolved.provider || tx.provider || null,
//         providerResponse: result?.raw || null,
//       },
//     };

//     await tx.save(sessOpts);

//     if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
//     session.endSession();

//     return {
//       success: true,
//       transactionId: tx._id.toString(),
//       status: tx.status,
//       providerStatus: tx.providerStatus,
//       providerReference: tx.providerReference,
//       provider: tx.provider || resolved.provider || null,
//     };
//   } catch (err) {
//     try {
//       if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     throw err;
//   }
// }

// module.exports = {
//   submitExternalExecution,
// };







"use strict";

const createError = require("http-errors");

const runtime = require("../shared/runtime");
const { resolveExecutor } = require("../providers/providerExecutorRegistry");

const {
  isSandboxUser,
  resolveUserId,
} = require("../../../utils/sandboxUser");

const {
  assertProviderAllowedForUser,
  normalizeProvider,
} = require("../../../utils/sandboxProviderGuard");

const {
  Transaction,
  startTxSession,
  maybeSessionOpts,
} = runtime;

function canUseSession() {
  if (typeof runtime.canUseSharedSession === "function") {
    return runtime.canUseSharedSession();
  }

  return Boolean(runtime.CAN_USE_SHARED_SESSION);
}

function safeEndSession(session) {
  try {
    if (session && typeof session.endSession === "function") {
      session.endSession();
    }
  } catch (_) {}
}

function safeObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function normalizeId(v) {
  return String(v || "").trim();
}

function buildSandboxCheckUser({ req, tx }) {
  const reqUser = safeObject(req?.user);

  return {
    ...reqUser,

    _id:
      reqUser._id ||
      reqUser.id ||
      tx?.sender ||
      tx?.userId ||
      tx?.user ||
      tx?.createdBy ||
      tx?.ownerUserId ||
      null,

    id:
      reqUser.id ||
      reqUser._id ||
      tx?.sender ||
      tx?.userId ||
      tx?.user ||
      tx?.createdBy ||
      tx?.ownerUserId ||
      null,

    email:
      reqUser.email ||
      tx?.senderEmail ||
      tx?.recipientEmail ||
      tx?.metadata?.requesterEmail ||
      tx?.meta?.requesterEmail ||
      null,

    isSandbox:
      reqUser.isSandbox === true ||
      tx?.isSandbox === true ||
      tx?.metadata?.sandbox === true ||
      tx?.meta?.sandbox === true,

    isReviewerAccount:
      reqUser.isReviewerAccount === true ||
      tx?.metadata?.isReviewerAccount === true ||
      tx?.meta?.isReviewerAccount === true,
  };
}

function isSandboxTransaction({ req, tx }) {
  const user = buildSandboxCheckUser({ req, tx });

  return Boolean(
    tx?.isSandbox === true ||
      tx?.provider === "sandbox" ||
      tx?.channel === "sandbox" ||
      tx?.metadata?.source === "apple_review_sandbox" ||
      tx?.meta?.source === "apple_review_sandbox" ||
      isSandboxUser(user)
  );
}

function buildSandboxProviderReference(tx) {
  if (tx?.providerReference) return tx.providerReference;

  const txId = tx?._id ? String(tx._id).slice(-8).toUpperCase() : "NOID";
  return `SBX-PROVIDER-SKIPPED-${txId}`;
}

async function markSandboxExecutionSkipped({ tx, sessOpts }) {
  const now = new Date();

  tx.provider = "sandbox";
  tx.channel = "sandbox";
  tx.providerStatus = "sandbox_completed";
  tx.providerReference = buildSandboxProviderReference(tx);

  if (!tx.status || ["pending", "processing", "initiated"].includes(String(tx.status))) {
    tx.status = "completed";
  }

  tx.isSandbox = true;
  tx.fundsCaptured = tx.fundsCaptured === true ? true : true;

  tx.metadata = {
    ...(tx.metadata || {}),
    sandbox: true,
    execution: {
      ...(tx.metadata?.execution || {}),
      skippedProviderExecution: true,
      skippedReason: "APPLE_REVIEW_SANDBOX",
      submittedAt: now.toISOString(),
      resolvedProvider: "sandbox",
      providerResponse: {
        ok: true,
        sandbox: true,
        message: "Aucun provider réel appelé pour Apple Review.",
      },
    },
  };

  tx.meta = {
    ...(tx.meta || {}),
    sandbox: true,
    providerExecutionSkipped: true,
  };

  tx.completedAt = tx.completedAt || now;
  tx.updatedAt = now;

  await tx.save(sessOpts);

  return {
    success: true,
    sandbox: true,
    providerSkipped: true,
    transactionId: tx._id.toString(),
    status: tx.status,
    providerStatus: tx.providerStatus,
    providerReference: tx.providerReference,
    provider: "sandbox",
  };
}

function resolveProviderCandidate({ tx, resolved }) {
  return normalizeProvider(
    tx?.provider ||
      resolved?.provider ||
      tx?.channel ||
      tx?.metadata?.provider ||
      tx?.meta?.provider ||
      ""
  );
}

async function submitExternalExecution({ req, transactionId }) {
  const session = await startTxSession();

  try {
    if (canUseSession()) {
      session.startTransaction();
    }

    const sessOpts = maybeSessionOpts(session);

    const tx = await Transaction.findById(transactionId).session(
      sessOpts.session || null
    );

    if (!tx) {
      throw createError(404, "Transaction introuvable");
    }

    /**
     * Barrière de sécurité Apple Review :
     * Une transaction sandbox ne doit jamais appeler un executor réel.
     */
    if (isSandboxTransaction({ req, tx })) {
      const result = await markSandboxExecutionSkipped({ tx, sessOpts });

      if (canUseSession()) {
        await session.commitTransaction();
      }

      safeEndSession(session);
      return result;
    }

    const resolved = resolveExecutor({
      flow: tx.flow,
      provider: tx.provider,
    });

    if (!resolved || typeof resolved.execute !== "function") {
      throw createError(400, `Aucun executor trouvé pour le flow ${tx.flow}`);
    }

    const sandboxCheckUser = buildSandboxCheckUser({ req, tx });
    const providerCandidate = resolveProviderCandidate({ tx, resolved });

    /**
     * Deuxième barrière :
     * Même si la tx n’est pas marquée isSandbox,
     * si le user Apple Review tente un provider réel, on bloque.
     */
    assertProviderAllowedForUser(sandboxCheckUser, providerCandidate);

    if (!tx.provider && resolved.provider) {
      tx.provider = resolved.provider;
    }

    const result = await resolved.execute({
      req,
      transaction: tx,
    });

    tx.providerStatus =
      result?.providerStatus ||
      tx.providerStatus ||
      "PROVIDER_SUBMITTED";

    tx.providerReference =
      result?.providerReference ||
      tx.providerReference ||
      null;

    if (tx.status === "pending") {
      tx.status = "processing";
    }

    tx.metadata = {
      ...(tx.metadata || {}),
      execution: {
        ...(tx.metadata?.execution || {}),
        submittedAt: new Date().toISOString(),
        resolvedProvider: resolved.provider || tx.provider || null,
        providerResponse: result?.raw || null,
      },
    };

    await tx.save(sessOpts);

    if (canUseSession()) {
      await session.commitTransaction();
    }

    safeEndSession(session);

    return {
      success: true,
      transactionId: tx._id.toString(),
      status: tx.status,
      providerStatus: tx.providerStatus,
      providerReference: tx.providerReference,
      provider: tx.provider || resolved.provider || null,
    };
  } catch (err) {
    try {
      if (canUseSession()) {
        await session.abortTransaction();
      }
    } catch (_) {}

    safeEndSession(session);
    throw err;
  }
}

module.exports = {
  submitExternalExecution,
};