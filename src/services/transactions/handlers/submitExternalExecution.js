"use strict";

const createError = require("http-errors");

const {
  Transaction,
  startTxSession,
  maybeSessionOpts,
  CAN_USE_SHARED_SESSION,
} = require("../shared/runtime");

const { resolveExecutor } = require("../providers/providerExecutorRegistry");

async function submitExternalExecution({ req, transactionId }) {
  const session = await startTxSession();

  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const sessOpts = maybeSessionOpts(session);

    const tx = await Transaction.findById(transactionId).session(sessOpts.session || null);
    if (!tx) {
      throw createError(404, "Transaction introuvable");
    }

    const resolved = resolveExecutor({
      flow: tx.flow,
      provider: tx.provider,
    });

    if (!resolved || typeof resolved.execute !== "function") {
      throw createError(400, `Aucun executor trouvé pour le flow ${tx.flow}`);
    }

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

    if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
    session.endSession();

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
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    throw err;
  }
}

module.exports = {
  submitExternalExecution,
};