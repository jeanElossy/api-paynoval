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

module.exports = router;
