// File: services/notificationService.js

require('dotenv').config();
const Joi           = require('joi');
const { Expo }      = require('expo-server-sdk');
const pino          = require('pino');
const promiseRetry  = require('promise-retry');
const User          = require('../models/User');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// 1️⃣ Schéma de validation des paramètres
const inputSchema = Joi.object({
  userId:   Joi.string().hex().length(24).required(),
  message:  Joi.string().trim().min(1).max(500).required(),
});

 // 2️⃣ Initialisation du client Expo pour l’envoi des push notifications
const expo = new Expo();

/**
 * Envoie une notification push via Expo à un utilisateur.
 * Utilise validation, logs structurés et retry en cas d’erreurs transitoires.
 *
 * @param {string} userId   - ObjectId Mongo de l’utilisateur (24 hexadecimal)
 * @param {string} message  - Corps du message (1–500 caractères)
 */
async function sendPushNotification(userId, message) {
  // ── a) Validation des inputs avec Joi
  const { error, value } = inputSchema.validate({ userId, message });
  if (error) {
    logger.error(
      { error: error.message, userId, message },
      'sendPushNotification : paramètres invalides'
    );
    throw new Error(`Paramètres invalides : ${error.message}`);
  }
  const { userId: uid, message: bodyText } = value;

  try {
    // ── b) Récupération des pushTokens en base pour cet utilisateur
    // On suppose que le schéma User définit désormais un champ `pushTokens: [String]`
    const user = await User.findById(uid).select('pushTokens').lean();
    if (!user) {
      logger.warn({ userId: uid }, 'sendPushNotification : Utilisateur non trouvé');
      return;
    }

    // ── c) Normalisation et filtrage des tokens Expo valides
    // Si `pushTokens` est une chaîne unique, on la transforme en tableau
    let tokens = [];
    if (Array.isArray(user.pushTokens)) {
      tokens = user.pushTokens.filter(Boolean);
    } else if (typeof user.pushTokens === 'string' && user.pushTokens.trim()) {
      tokens = [user.pushTokens.trim()];
    }
    // Garder uniquement les tokens valides pour Expo
    tokens = tokens.filter(t => Expo.isExpoPushToken(t));

    if (!tokens.length) {
      logger.warn({ userId: uid }, 'sendPushNotification : Aucun token Expo valide');
      return;
    }

    // ── d) Construction des messages à envoyer
    const notifications = tokens.map(token => ({
      to:     token,
      sound:  'default',
      body:   bodyText,
      data:   { sentAt: new Date().toISOString() },
    }));

    // ── e) Découpage en chunks puis envoi avec retry exponentiel
    const chunks = expo.chunkPushNotifications(notifications);
    for (const chunk of chunks) {
      await promiseRetry(
        async (retry, attempt) => {
          try {
            const receipts = await expo.sendPushNotificationsAsync(chunk);
            logger.info(
              { receipts, chunkSize: chunk.length, attempt },
              'sendPushNotification : chunk envoyé avec succès'
            );
          } catch (err) {
            logger.error({ err, attempt }, 'sendPushNotification : erreur envoi chunk, nouvelle tentative…');
            retry(err);
          }
        },
        { retries: 3, factor: 2, minTimeout: 1000, maxTimeout: 4000 }
      );
    }
  } catch (err) {
    logger.error({ err, userId: uid }, 'sendPushNotification : échec global');
  }
}

module.exports = { sendPushNotification };
