const db = require('../config/database');
const { classifyTerritory } = require('../services/territoryService');
const { parseCSV, parseXLSX, enrichWithTerritory } = require('../services/importService');
const { notifyEventApproved, notifyEventRejected } = require('../services/notificationService');
const fs = require('fs');

async function listEvents(req, res) {
  try {
    const { status, territory, search, page = 1, limit = 20 } = req.query;
    const effectiveStatus = req.user?.role === 'admin' ? (status || null) : 'approved';
    let where = [], params = [], idx = 1;
    if (effectiveStatus) { where.push(`e.status = $${idx++}`); params.push(effectiveStatus); }
    if (territory) { where.push(`e.territory = $${idx++}`); params.push(territory); }
    if (search) {
      where.push(`(LOWER(e.name) LIKE $${idx} OR LOWER(e.description) LIKE $${idx})`);
      params.push(`%${search.toLowerCase()}%`); idx++;
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countResult = await db.query(`SELECT COUNT(*) FROM events e ${whereClause}`, params);
    const { rows } = await db.query(
      `SELECT e.*, u.name AS creator_name, u.email AS creator_email,
         COALESCE(JSON_AGG(JSON_BUILD_OBJECT('id', g.id, 'name', g.guest_name, 'email', g.guest_email))
         FILTER (WHERE g.id IS NOT NULL), '[]') AS guests
       FROM events e
       LEFT JOIN users u ON e.created_by = u.id
       LEFT JOIN event_guests g ON g.event_id = e.id
       ${whereClause}
       GROUP BY e.id, u.name, u.email
       ORDER BY e.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit), offset]
    );
    res.json({ data: rows, pagination: {
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page), limit: parseInt(limit),
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
    }});
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao listar eventos' }); }
}

async function getEvent(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT e.*, u.name AS creator_name, u.email AS creator_email,
         COALESCE(JSON_AGG(JSON_BUILD_OBJECT('id', g.id, 'name', g.guest_name, 'email', g.guest_email))
         FILTER (WHERE g.id IS NOT NULL), '[]') AS guests
       FROM events e
       LEFT JOIN users u ON e.created_by = u.id
       LEFT JOIN event_guests g ON g.event_id = e.id
       WHERE e.id = $1
       GROUP BY e.id, u.name, u.email`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Evento não encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar evento' }); }
}

async function createEvent(req, res) {
  const client = await db.getClient();
  try {
    const { name, description, city, country, event_date, guests = [] } = req.body;
    if (!name || !city || !country) return res.status(400).json({ error: 'Campos obrigatórios: name, city, country' });
    const territory = await classifyTerritory(country);
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO events (name, description, city, country, territory, event_date, created_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual') RETURNING *`,
      [name, description, city, country, territory, event_date || null, req.user?.id || null]
    );
    for (const g of guests) {
      const gName = typeof g === 'string' ? g : g.name;
      const gEmail = typeof g === 'object' ? (g.email || null) : null;
      await client.query(`INSERT INTO event_guests (event_id, guest_name, guest_email) VALUES ($1, $2, $3)`, [rows[0].id, gName, gEmail]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], guests, message: 'Evento criado com status "Pendente".' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao criar evento' });
  } finally { client.release(); }
}
async function reviewEvent(req, res) {
  const client = await db.getClient();
  try {
    const { action, rejection_reason } = req.body;
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Use "approve" ou "reject"' });
    const { rows } = await client.query(
      `SELECT e.*, u.name AS creator_name, u.email AS creator_email
       FROM events e LEFT JOIN users u ON e.created_by = u.id WHERE e.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Evento não encontrado' });
    if (rows[0].status !== 'pending') return res.status(400).json({ error: `Evento já está "${rows[0].status}"` });
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE events SET status = $1, reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $3 WHERE id = $4 RETURNING *`,
      [action === 'approve' ? 'approved' : 'rejected', req.user.id, rejection_reason || null, req.params.id]
    );
    await client.query('COMMIT');
    if (rows[0].created_by) {
      const notify = action === 'approve' ? notifyEventApproved : notifyEventRejected;
      notify({ eventId: rows[0].id, eventName: rows[0].name, userEmail: rows[0].creator_email, userName: rows[0].creator_name, userId: rows[0].created_by, reason: rejection_reason }).catch(console.error);
    }
    res.json({ event: updated[0], message: action === 'approve' ? 'Evento aprovado!' : 'Evento rejeitado.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao revisar evento' });
  } finally { client.release(); }
}
async function importFile(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    let parsed;
    if (ext === 'csv') {
      parsed = parseCSV(fs.readFileSync(req.file.path, 'utf-8'));
    } else if (['xlsx', 'xls'].includes(ext)) {
      parsed = parseXLSX(fs.readFileSync(req.file.path));
    } else {
      return res.status(400).json({ error: 'Use .csv ou .xlsx' });
    }
    const enriched = await enrichWithTerritory(parsed.records);
    const client = await db.getClient();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      for (const record of enriched) {
        const { rows } = await client.query(
          `INSERT INTO events (name, description, city, country, territory, event_date, created_by, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [record.name, record.description, record.city, record.country, record.territory, record.event_date, req.user?.id || null, record.source]
        );
        for (const g of record.guests) {
          await client.query(`INSERT INTO event_guests (event_id, guest_name) VALUES ($1, $2)`, [rows[0].id, g]);
        }
        inserted++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
    } finally {
      client.release();
      fs.unlinkSync(req.file.path);
    }
    res.json({ inserted, parseErrors: parsed.errors, message: `${inserted} evento(s) importado(s).` });
  } catch (err) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: err.message || 'Erro ao importar' });
  }
}

module.exports = { listEvents, getEvent, createEvent, reviewEvent, importFile };
