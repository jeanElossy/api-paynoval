// // src/routes/notificationRoutes.js
// const express       = require('express');
// const asyncHandler  = require('express-async-handler');
// const Notification  = require('../models/Notification');
// const { protect }   = require('../middleware/authMiddleware');

// const router = express.Router();


// // GET /api/v1/notifications
// router.get(
//     '/',
//     protect,
//     asyncHandler(async (req, res) => {
//         const notifs = await Notification
//         .find({ recipient: req.user.id })
//         .sort({ createdAt: -1 });
//         res.json({ success: true, data: notifs });
//     })
// );


// // PATCH /api/v1/notifications/:id/read
// router.patch(
//     '/:id/read',
//     protect,
//     asyncHandler(async (req, res) => {
//         const notif = await Notification.findOneAndUpdate(
//         { _id: req.params.id, recipient: req.user.id },
//         { read: true },
//         { new: true }
//         );
//         if (!notif) {
//         return res.status(404).json({ success: false, error: 'Notification introuvable' });
//         }
//         res.json({ success: true, data: notif });
//     })
// );


// // (Optionnel) DELETE /api/v1/notifications/:id
// router.delete(
//     '/:id',
//     protect,
//     asyncHandler(async (req, res) => {
//         const notif = await Notification.findOneAndDelete(
//         { _id: req.params.id, recipient: req.user.id }
//         );
//         if (!notif) {
//         return res.status(404).json({ success: false, error: 'Notification introuvable' });
//         }
//         res.json({ success: true });
//     })
// );


// // (Optionnel) GET /api/v1/notifications/count
// router.get(
//     '/count',
//     protect,
//     asyncHandler(async (req, res) => {
//         const count = await Notification.countDocuments({
//         recipient: req.user.id,
//         read: false
//         });
//         res.json({ success: true, data: { count } });
//     })
// );


// module.exports = router;




// File: src/routes/notificationRoutes.js

const express      = require('express');
const asyncHandler = require('express-async-handler');
const { protect }  = require('../middleware/authMiddleware');
const Notification = require('../models/Notification');

const router = express.Router();

/**
 * GET /api/v1/notifications
 * Récupère les notifications reçues pour l'utilisateur connecté
 */
router.get(
  '/',
  protect,
  asyncHandler(async (req, res) => {
    // Recherche toutes les notifications dont le recipient correspond à l'utilisateur
    const notifs = await Notification
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
    const notif = await Notification.findOneAndUpdate(
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
 * Supprime une notification
 */
router.delete(
  '/:id',
  protect,
  asyncHandler(async (req, res) => {
    const notif = await Notification.findOneAndDelete(
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
 * Renvoie le nombre de notifications non lues
 */
router.get(
  '/count',
  protect,
  asyncHandler(async (req, res) => {
    const count = await Notification.countDocuments({
      recipient: req.user.id,
      read: false
    });

    res.json({ success: true, data: { count } });
  })
);

module.exports = router;

