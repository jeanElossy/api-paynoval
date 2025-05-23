// scripts/seedBalance.js
require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('../src/models/User');  // ou le bon chemin selon ton projet

async function main() {
  await mongoose.connect(process.env.MONGO_URI_USERS);
  const userId = '683065f64d699e1c619bce9b';     // ton user de test
  await User.findByIdAndUpdate(
    userId,
    { balance: mongoose.Types.Decimal128.fromString('25000.00') }
  );
  console.log('✅ Solde mis à jour à 25 000 €');
  process.exit();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
