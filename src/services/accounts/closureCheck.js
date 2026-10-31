"use strict";

const { INFLIGHT_STATUSES } = require("../serviceControl/inflight");

const FIELDS = ["amount", "availableAmount", "reservedAmount"];

/**
 * What still ties a client to PayNoval, read from the books. Pure.
 * An unreadable balance blocks: closing on a guess would strand the money.
 */
function closureBlockers({ wallets = [], inFlightCount }) {
  const blockers = [];

  for (const wallet of wallets) {
    const values = FIELDS.map((field) => Number(String(wallet?.[field] ?? "0")));

    if (values.some((value) => !Number.isFinite(value))) {
      blockers.push({ code: "WALLET_UNREADABLE", currency: wallet?.currency || null });
    } else if (values.some((value) => value !== 0)) {
      blockers.push({ code: "WALLET_NOT_EMPTY", currency: wallet?.currency || null });
    }
  }

  if (!Number.isInteger(inFlightCount)) blockers.push({ code: "IN_FLIGHT_UNREADABLE" });
  else if (inFlightCount > 0) blockers.push({ code: "TRANSACTIONS_IN_FLIGHT", count: inFlightCount });

  return blockers;
}

async function readClosureBlockers({ userId, Wallet, Transaction }) {
  const [wallets, inFlightCount] = await Promise.all([
    Wallet.find({ user: userId }).select("currency amount availableAmount reservedAmount").lean(),
    Transaction.countDocuments({
      status: { $in: [...INFLIGHT_STATUSES] },
      $or: [{ userId }, { sender: userId }, { receiver: userId }],
    }),
  ]);

  return closureBlockers({ wallets, inFlightCount });
}

module.exports = { closureBlockers, readClosureBlockers };
