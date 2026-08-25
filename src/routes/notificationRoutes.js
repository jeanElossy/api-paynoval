// File: src/routes/notificationRoutes.js

const express      = require('express');
const asyncHandler = require('express-async-handler');
const { protect }  = require('../middleware/authMiddleware');

// ALWAYS inject connection if you are in a multi-DB architecture
const { getUsersConn } = require('../config/db');

/**
 * Résolution PARESSEUSE du modèle.
 *
 * `getUsersConn()` lève tant que la base n'est pas connectée : résoudre le
 * modèle au premier niveau rendait ce fichier — et tout ce qui le monte —
 * impossible à charger dans un test. Même correction que dans `src/config.js`
 * et `services/validationService.js` : on résout au premier usage.
 */
let _Notification = null;

function getNotificationModel() {
  if (!_Notification) {
    _Notification = require('../models/Notification')(getUsersConn());
  }

  return _Notification;
}

const router = express.Router();

/**
 * GET /api/v1/notifications
 * Récupère les notifications de l'utilisateur connecté (par ordre décroissant)
 */
router.get(
  '/',
  protect,
  asyncHandler(async (req, res) => {
    const notifs = await getNotificationModel()
      .find({ recipient: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: notifs });
  })
);

/**
 * PATCH /api/v1/notifications/:id/read
 * Marque une notification comme lue
 */
router.patch(
  '/:id/read',
  protect,
  asyncHandler(async (req, res) => {
    const notif = await getNotificationModel().findOneAndUpdate(
      { _id: req.params.id, recipient: req.user.id },
      { read: true },
      { new: true }
    ).lean();

    if (!notif) {
      return res.status(404).json({ success: false, error: 'Notification introuvable' });
    }

    res.json({ success: true, data: notif });
  })
);

/**
 * DELETE /api/v1/notifications/:id
 * Supprime une notification de l'utilisateur connecté
 */
router.delete(
  '/:id',
  protect,
  asyncHandler(async (req, res) => {
    const notif = await getNotificationModel().findOneAndDelete(
      { _id: req.params.id, recipient: req.user.id }
    ).lean();

    if (!notif) {
      return res.status(404).json({ success: false, error: 'Notification introuvable' });
    }

    res.json({ success: true });
  })
);

/**
 * GET /api/v1/notifications/count
 * Renvoie le nombre de notifications non lues pour l'utilisateur connecté
 */
router.get(
  '/count',
  protect,
  asyncHandler(async (req, res) => {
    const count = await getNotificationModel().countDocuments({
      recipient: req.user.id,
      read: false
    });

    res.json({ success: true, data: { count } });
  })
);

module.exports = router;
