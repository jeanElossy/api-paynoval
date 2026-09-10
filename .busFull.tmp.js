process.env.EVENT_STREAM_KEY = "paynoval.events.full";
require("dotenv").config();
const Redis = require("ioredis");
const mongoose = require("mongoose");
const { connectTransactionsDB, getTxConn } = require("./src/config/db");

(async () => {
  await connectTransactionsDB();
  const conn = getTxConn();
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
  require("./src/services/redisClientAccessor").setClient(redis);

  const stream = require("./src/services/events/stream");
  const relay = require("./src/services/events/relay");
  const { publishDomainEvent } = require("./src/services/events/publisher");
  const DomainEvent = require("./src/models/DomainEvent")(conn);
  const ProcessedEvent = require("./src/models/ProcessedEvent")(conn);

  const muet = { info() {}, warn() {}, error() {} };
  const oid = new mongoose.Types.ObjectId().toString();
  const uid = new mongoose.Types.ObjectId().toString();
  const m = `full-${Date.now()}`;

  const s = await conn.startSession();
  await s.withTransaction(async () => {
    await publishDomainEvent({ name: "transaction.confirmed.v1", aggregateId: oid,
      payload: { transactionId: oid, amount: 100, currency: "XOF", senderId: uid } }, s);
    await publishDomainEvent({ name: "referral.activity.confirmed.v1", aggregateId: `${m}-r`,
      payload: { refereeId: uid, triggerTxId: oid, correlationId: `${m}-corr` } }, s);
    await publishDomainEvent({ name: "notification.requested.v1", aggregateId: `${m}-n`,
      payload: { recipient: uid, idempotencyKey: `${m}-key`, title: "Virement reçu",
                 message: "Vous avez reçu 100 XOF", channels: ["push"], priority: 2 } }, s);
  });
  await s.endSession();

  const b = await relay.tick({ logger: muet });
  console.log(`\n  relais : ${b.publies} publié(s), ${b.echecs} échec(s)\n`);

  const BRANCHES = [
    ["🛡️  risque         ", require("./src/services/risk/monitoringConsumer")],
    ["📒 réconciliation ", require("./src/services/reconciliation/settlementConsumer")],
    ["🎁 parrainage     ", require("./src/services/referral/referralConsumer")],
    ["🔔 notifications  ", require("./src/services/notifications/notificationConsumer")],
  ];

  for (const [nom, branche] of BRANCHES) {
    const c = branche.build({ logger: muet });
    await stream.ensureGroup(c.groupe);
    const bilan = await c.tick();
    const reg = await ProcessedEvent.findOne({ group: c.groupe, processedAt: { $gte: new Date(Date.now() - 60000) } }).lean();
    console.log(`  ${nom} traités=${bilan.traites} échecs=${bilan.echecs}  →  ${reg ? reg.outcome : "(rien au registre)"}`);
  }

  console.log("\n  ── idempotence : on rejoue TOUT le lot");
  await relay.tick({ logger: muet });
  for (const [nom, branche] of BRANCHES) {
    const c = branche.build({ logger: muet });
    const bilan = await c.tick();
    console.log(`  ${nom} doublons=${bilan.doublons} nouveaux traitements=${bilan.traites}`);
  }

  await DomainEvent.deleteMany({ $or: [{ aggregateId: { $regex: `^${m}` } }, { aggregateId: oid }] });
  await ProcessedEvent.deleteMany({ processedAt: { $gte: new Date(Date.now() - 180000) } });
  await redis.del(stream.FLUX);
  console.log("\n  nettoyage effectué\n");
  await redis.quit();
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error("  ✗", e.message); process.exit(1); });
