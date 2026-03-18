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
router.get('/events', authenticate, eventsCtrl.listEvents);
router.get('/events/:id', authenticate, eventsCtrl.getEvent);
router.post('/events', authenticate, eventsCtrl.createEvent);
router.post('/events/import', authenticate, upload.single('file'), eventsCtrl.importFile);
router.patch('/events/:id/review', authenticate, requireAdmin, eventsCtrl.reviewEvent);

// Editar evento (dono do evento, apenas se pendente)
router.put('/events/:id', authenticate, async (req, res) => {
  try {
    const db = require('../config/database');
    const { rows } = await db.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Evento não encontrado' });
    const event = rows[0];

    if (req.user.role !== 'admin' && parseInt(event.created_by) !== parseInt(req.user.id)) {
      return res.status(403).json({ error: 'Sem permissão para editar este evento' });
    }
    if (req.user.role !== 'admin' && event.status !== 'pending') {
      return res.status(400).json({ error: 'Só é possível editar eventos pendentes' });
    }

    const { name, description, city, country, event_date } = req.body;
    const { classifyTerritory } = require('../services/territoryService');
    const territory = await classifyTerritory(country);

    const { rows: updated } = await db.query(
      `UPDATE events SET name=$1, description=$2, city=$3, country=$4,
       territory=$5, event_date=$6 WHERE id=$7 RETURNING *`,
      [name, description, city, country, territory, event_date || null, req.params.id]
    );
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao editar evento' });
  }
});

// Deletar evento (dono se pendente, admin qualquer)
router.delete('/events/:id', authenticate, async (req, res) => {
  try {
    const db = require('../config/database');
    const { rows } = await db.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Evento não encontrado' });
    const event = rows[0];

    if (req.user.role !== 'admin' && parseInt(event.created_by) !== parseInt(req.user.id)) {
      return res.status(403).json({ error: 'Sem permissão para deletar este evento' });
    }
    if (req.user.role !== 'admin' && event.status !== 'pending') {
      return res.status(400).json({ error: 'Só é possível deletar eventos pendentes' });
    }

    await db.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ message: 'Evento deletado' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao deletar evento' });
  }
});

// Admin pendentes
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

router.post('/regions', authenticate, requireAdmin, async (req, res) => {
  try {
    const { country_name, country_code, territory } = req.body;
    if (!country_name || !territory) {
      return res.status(400).json({ error: 'country_name e territory são obrigatórios' });
    }
    const validTerritories = ['Brazil', 'Mexico', 'NOLA', 'SOLA'];
    if (!validTerritories.includes(territory)) {
      return res.status(400).json({ error: 'Território inválido' });
    }
    const db = require('../config/database');
    const { rows } = await db.query(
      `INSERT INTO regions (country_name, country_code, territory)
       VALUES ($1, $2, $3) RETURNING *`,
      [country_name, country_code || null, territory]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao adicionar região' });
  }
});

router.put('/regions/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { country_name, country_code, territory } = req.body;
    const validTerritories = ['Brazil', 'Mexico', 'NOLA', 'SOLA'];
    if (!validTerritories.includes(territory)) {
      return res.status(400).json({ error: 'Território inválido' });
    }
    const db = require('../config/database');
    const { rows } = await db.query(
      `UPDATE regions SET country_name = $1, country_code = $2, territory = $3
       WHERE id = $4 RETURNING *`,
      [country_name, country_code || null, territory, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Região não encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar região' });
  }
});

router.delete('/regions/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = require('../config/database');
    await db.query('DELETE FROM regions WHERE id = $1', [req.params.id]);
    res.json({ message: 'Região removida' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover região' });
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
