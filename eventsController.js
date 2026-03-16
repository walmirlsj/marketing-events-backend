// src/controllers/eventsController.js
const db = require('../config/database');
const { classifyTerritory } = require('../services/territoryService');
const { parseCSV, parseXLSX, enrichWithTerritory } = require('../services/importService');
const { notifyEventApproved, notifyEventRejected } = require('../services/notificationService');
const fs = require('fs');

// ─── LISTAR EVENTOS ────────────────────────────────────────────────────────────
async function listEvents(req, res) {
  try {
    const {
      status = 'approved',
      territory,
      country,
      search,
      page = 1,
      limit = 20,
    } = req.query;

    // Admin pode ver todos os status; usuário comum só vê aprovados
    const effectiveStatus = req.user?.role === 'admin' ? (status || null) : 'approved';

    let where = [];
    let params = [];
    let idx = 1;

    if (effectiveStatus) {
      where.push(`e.status = $${idx++}`);
      params.push(effectiveStatus);
    }
    if (territory) {
      where.push(`e.territory = $${idx++}`);
      params.push(territory);
    }
    if (country) {
      where.push(`LOWER(e.country) = LOWER($${idx++})`);
      params.push(country);
    }
    if (search) {
      where.push(`(LOWER(e.name) LIKE $${idx} OR LOWER(e.description) LIKE $${idx})`);
      params.push(`%${search.toLowerCase()}%`);
      idx++;
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countResult = await db.query(
      `SELECT COUNT(*) FROM events e ${whereClause}`,
      params
    );

    const { rows } = await db.query(
      `SELECT
         e.*,
         u.name AS creator_name, u.email AS creator_email,
         a.name AS reviewer_name,
         COALESCE(
           JSON_AGG(
             JSON_BUILD_OBJECT('id', g.id, 'name', g.guest_name, 'email', g.guest_email)
           ) FILTER (WHERE g.id IS NOT NULL),
           '[]'
         ) AS guests
       FROM events e
       LEFT JOIN users u ON e.created_by = u.id
       LEFT JOIN users a ON e.reviewed_by = a.id
       LEFT JOIN event_guests g ON g.event_id = e.id
       ${whereClause}
       GROUP BY e.id, u.name, u.email, a.name
       ORDER BY e.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      data: rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar eventos' });
  }
}

// ─── BUSCAR EVENTO POR ID ──────────────────────────────────────────────────────
async function getEvent(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT
         e.*,
         u.name AS creator_name, u.email AS creator_email,
         a.name AS reviewer_name,
         COALESCE(
           JSON_AGG(
             JSON_BUILD_OBJECT('id', g.id, 'name', g.guest_name, 'email', g.guest_email)
           ) FILTER (WHERE g.id IS NOT NULL),
           '[]'
         ) AS guests
       FROM events e
       LEFT JOIN users u ON e.created_by = u.id
       LEFT JOIN users a ON e.reviewed_by = a.id
       LEFT JOIN event_guests g ON g.event_id = e.id
       WHERE e.id = $1
       GROUP BY e.id, u.name, u.email, a.name`,
      [req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Evento não encontrado' });

    const event = rows[0];
    // Usuário comum só vê eventos aprovados (ou seus próprios)
    if (req.user?.role !== 'admin' &&
        event.status !== 'approved' &&
        event.created_by !== req.user?.id) {
      return res.status(404).json({ error: 'Evento não encontrado' });
    }

    res.json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar evento' });
  }
}

// ─── CRIAR EVENTO (MANUAL) ─────────────────────────────────────────────────────
async function createEvent(req, res) {
  const client = await db.getClient();
  try {
    const { name, description, city, country, event_date, guests = [] } = req.body;

    if (!name || !city || !country) {
      return res.status(400).json({ error: 'Campos obrigatórios: name, city, country' });
    }

    // Classificação automática de território
    const territory = await classifyTerritory(country);

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO events (name, description, city, country, territory, event_date, created_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual')
       RETURNING *`,
      [name, description, city, country, territory, event_date || null, req.user?.id || null]
    );

    const event = rows[0];

    // Insere convidados (multi-valor)
    if (guests.length > 0) {
      const guestValues = guests.map((g, i) => {
        const name = typeof g === 'string' ? g : g.name;
        const email = typeof g === 'object' ? g.email : null;
        return `($1, $${i * 2 + 2}, $${i * 2 + 3})`;
      });

      // Alternativo mais robusto para múltiplos convidados
      for (const g of guests) {
        const gName = typeof g === 'string' ? g : g.name;
        const gEmail = typeof g === 'object' ? (g.email || null) : null;
        await client.query(
          `INSERT INTO event_guests (event_id, guest_name, guest_email) VALUES ($1, $2, $3)`,
          [event.id, gName, gEmail]
        );
      }
    }

    await client.query('COMMIT');

    res.status(201).json({
      ...event,
      guests,
      message: `Evento criado com status "Pendente". Aguardando aprovação do administrador.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar evento' });
  } finally {
    client.release();
  }
}

// ─── APROVAR/REJEITAR EVENTO (ADMIN) ──────────────────────────────────────────
async function reviewEvent(req, res) {
  const client = await db.getClient();
  try {
    const { id } = req.params;
    const { action, rejection_reason } = req.body; // action: 'approve' | 'reject'

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Ação inválida. Use "approve" ou "reject"' });
    }

    // Busca evento + dados do criador
    const { rows } = await client.query(
      `SELECT e.*, u.name AS creator_name, u.email AS creator_email
       FROM events e
       LEFT JOIN users u ON e.created_by = u.id
       WHERE e.id = $1`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Evento não encontrado' });

    const event = rows[0];
    if (event.status !== 'pending') {
      return res.status(400).json({ error: `Evento já está com status "${event.status}"` });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    await client.query('BEGIN');

    const { rows: updated } = await client.query(
      `UPDATE events
       SET status = $1,
           reviewed_by = $2,
           reviewed_at = NOW(),
           rejection_reason = $3
       WHERE id = $4
       RETURNING *`,
      [newStatus, req.user.id, rejection_reason || null, id]
    );

    await client.query('COMMIT');

    // Dispara notificação ao cadastrador (async, não bloqueia resposta)
    if (event.created_by) {
      if (action === 'approve') {
        notifyEventApproved({
          eventId: event.id,
          eventName: event.name,
          userEmail: event.creator_email,
          userName: event.creator_name,
          userId: event.created_by,
        }).catch(console.error);
      } else {
        notifyEventRejected({
          eventId: event.id,
          eventName: event.name,
          userEmail: event.creator_email,
          userName: event.creator_name,
          userId: event.created_by,
          reason: rejection_reason,
        }).catch(console.error);
      }
    }

    res.json({
      event: updated[0],
      message: action === 'approve'
        ? 'Evento aprovado e movido para a Base Oficial. Notificação enviada ao cadastrador.'
        : 'Evento rejeitado. Notificação enviada ao cadastrador.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Erro ao revisar evento' });
  } finally {
    client.release();
  }
}

// ─── IMPORTAR ARQUIVO CSV/XLSX ─────────────────────────────────────────────────
async function importFile(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  try {
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    let parsed;

    if (ext === 'csv') {
      const content = fs.readFileSync(req.file.path, 'utf-8');
      parsed = parseCSV(content);
    } else if (['xlsx', 'xls'].includes(ext)) {
      const buffer = fs.readFileSync(req.file.path);
      parsed = parseXLSX(buffer);
    } else {
      return res.status(400).json({ error: 'Formato não suportado. Use .csv ou .xlsx' });
    }

    const enriched = await enrichWithTerritory(parsed.records);

    const client = await db.getClient();
    let inserted = 0;
    const insertErrors = [];

    try {
      await client.query('BEGIN');
      for (const record of enriched) {
        try {
          const { rows } = await client.query(
            `INSERT INTO events (name, description, city, country, territory, event_date, created_by, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [record.name, record.description, record.city, record.country,
             record.territory, record.event_date, req.user?.id || null, record.source]
          );
          const eventId = rows[0].id;
          for (const g of record.guests) {
            await client.query(
              `INSERT INTO event_guests (event_id, guest_name) VALUES ($1, $2)`,
              [eventId, g]
            );
          }
          inserted++;
        } catch (e) {
          insertErrors.push(`"${record.name}": ${e.message}`);
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
      fs.unlinkSync(req.file.path); // remove arquivo temporário
    }

    res.json({
      inserted,
      parseErrors: parsed.errors,
      insertErrors,
      message: `${inserted} evento(s) importado(s) com status "Pendente".`,
    });
  } catch (err) {
    console.error(err);
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: err.message || 'Erro ao importar arquivo' });
  }
}

module.exports = { listEvents, getEvent, createEvent, reviewEvent, importFile };
