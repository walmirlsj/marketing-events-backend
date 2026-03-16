const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { authenticate, requireAdmin, optionalAuth } = require('../middleware/auth');
const authCtrl = require('../controllers/authController');
const eventsCtrl = require('../controllers/eventsController');
const { listRegions, importRegionsFromCSV } = require('../services/territoryService');
const { getUserNotifications, markAsRead } = require('../services/notificationService');

const router = express.Router();

const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Tipo não suportado: ${ext}`));
  },
});

// Auth
router.post('/auth/register', authCtrl.register);
router.post('/auth/login', authCtrl.login);
router.get('/auth/me', authenticate, authCtrl.getProfile);

// Events
router.get('/events', optionalAuth, eventsCtrl.listEvents);
router.get('/events/:id', optionalAuth, eventsCtrl.getEvent);
router.post('/events', optionalAuth, eventsCtrl.createEvent);
router.post('/events/import', authenticate, upload.single('file'), eventsCtrl.importFile);
router.patch('/events/:id/review', authenticate, requireAdmin, eventsCtrl.reviewEvent);

// Admin
router.get('/admin/events/pending', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = require('../config/database');
    const { rows } = await db.query(
      `SELECT e.*, u.name AS creator_name, u.email AS creator_email,
         COUNT(g.id)::int AS guest_count
       FROM events e
       LEFT JOIN users u ON e.created_by = u.id
       LEFT JOIN event_guests g ON g.event_id = e.id
       WHERE e.status = 'pending'
       GROUP BY e.id, u.name, u.email
       ORDER BY e.created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar pendentes' });
  }
});

// Regiões
router.get('/regions', async (req, res) => {
  try {
    res.json(await listRegions());
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar regiões' });
  }
});

router.post('/regions/import', authenticate, requireAdmin,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
    try {
      const content = fs.readFileSync(req.file.path, 'utf-8');
      const result = await importRegionsFromCSV(content);
      fs.unlinkSync(req.file.path);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Notificações
router.get('/notifications', authenticate, async (req, res) => {
  try {
    res.json(await getUserNotifications(req.user.id));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar notificações' });
  }
});

router.patch('/notifications/read', authenticate, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: '"ids" deve ser um array' });
    }
    await markAsRead(req.user.id, ids);
    res.json({ message: 'Notificações marcadas como lidas' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar notificações' });
  }
});

module.exports = router;
