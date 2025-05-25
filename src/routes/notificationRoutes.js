// src/routes/notificationRoutes.js
const express       = require('express');
const asyncHandler  = require('express-async-handler');
const Notification  = require('../models/Notification');
const { protect }   = require('../middleware/authMiddleware');

const router = express.Router();

// GET /api/v1/notifications
router.get(
  '/',
  protect,
  asyncHandler(async (req, res) => {
    const notifs = await Notification
      .find({ recipient: req.user.id })
      .sort({ createdAt: -1 });
    res.json({ success: true, data: notifs });
  })
);

// PATCH /api/v1/notifications/:id/read
router.patch(
  '/:id/read',
  protect,
  asyncHandler(async (req, res) => {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user.id },
      { read: true },
      { new: true }
    );
    if (!notif) {
      return res.status(404).json({ success: false, error: 'Notification introuvable' });
    }
    res.json({ success: true, data: notif });
  })
);

// (Optionnel) DELETE /api/v1/notifications/:id
router.delete(
  '/:id',
  protect,
  asyncHandler(async (req, res) => {
    const notif = await Notification.findOneAndDelete(
      { _id: req.params.id, recipient: req.user.id }
    );
    if (!notif) {
      return res.status(404).json({ success: false, error: 'Notification introuvable' });
    }
    res.json({ success: true });
  })
);

// (Optionnel) GET /api/v1/notifications/count
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
