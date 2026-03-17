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
"Commit changes" e me confirma! O Render vai fazer redeploy automaticamente.feito09:12Agora aguarde cerca de 2 minutos — o Render vai detectar o novo arquivo e fazer o redeploy automaticamente.
Fique de olho nos logs do Render. O que estamos esperando ver é:
🚀 Marketing Events API running on http://localhost:3001
Me manda um print dos logs quando aparecer algo novo!ta nisso ai09:19Ótimo progresso! O build foi bem-sucedido 🎉 e agora está fazendo o deploy. Veja:

✅ Build successful
⏳ Deploying... — aguardando o health check responder

Aguarde mais 1 minuto e role os logs para baixo para ver o resultado final. Deve aparecer algo como:
🚀 Marketing Events API running on http://localhost:3001
==> Your service is live 🎉
Me manda um print quando atualizar!09:25O erro é SyntaxError: Unexpected end of input no importService.js linha 83 — significa que o arquivo foi cortado e está incompleto no GitHub.
Vá ao GitHub, abra o arquivo src/services/importService.js e verifique se o final do arquivo tem esta parte:
javascriptmodule.exports = { parseCSV, parseXLSX, enrichWithTerritory };
Se não tiver, clique no lápis (editar) e adicione no final. Se o arquivo estiver muito incompleto, delete e recrie.
Me diz o que aparece no final do arquivo!a ultima linha esta na 82 e é   const result = par09:27O arquivo foi cortado! Vamos deletar e recriar. No GitHub:

Abra o arquivo src/services/importService.js
Clique no ícone de lixeira (Delete file)
Confirme o delete

Depois crie novamente com "Add file" → "Create new file", nome src/services/importService.js e cole todo este conteúdo de uma vez:
javascriptconst XLSX = require('xlsx');
const { classifyTerritory } = require('./territoryService');

function parseCSV(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV vazio ou sem dados');
  const headers = lines[0].split(';').map(h => h.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const COL_ALIASES = {
    name: ['nome_evento','nome','event_name','name','evento'],
    description: ['descricao','description','desc'],
    city: ['cidade','city'],
    country: ['pais','country','pais_evento'],
    guests: ['convidados','guests','lista_convidados','participantes'],
    date: ['data','date','data_evento','event_date'],
  };
  function findCol(field) {
    for (const alias of COL_ALIASES[field]) {
      const idx = headers.indexOf(alias);
      if (idx !== -1) return idx;
    }
    return -1;
  }
  const colMap = {
    name: findCol('name'),
    description: findCol('description'),
    city: findCol('city'),
    country: findCol('country'),
    guests: findCol('guests'),
    date: findCol('date'),
  };
  if (colMap.name === -1) throw new Error('Coluna "nome_evento" não encontrada');
  if (colMap.city === -1) throw new Error('Coluna "cidade" não encontrada');
  if (colMap.country === -1) throw new Error('Coluna "pais" não encontrada');
  const records = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';').map(c => c.trim());
    const get = (idx) => (idx !== -1 && cols[idx]) ? cols[idx].trim() : '';
    const name = get(colMap.name);
    const city = get(colMap.city);
    const country = get(colMap.country);
    if (!name || !city || !country) {
      errors.push(`Linha ${i + 1}: campos obrigatórios ausentes`);
      continue;
    }
    const guestsRaw = get(colMap.guests);
    const guests = guestsRaw ? guestsRaw.split(',').map(g => g.trim()).filter(Boolean) : [];
    records.push({
      name,
      description: get(colMap.description),
      city,
      country,
      guests,
      event_date: get(colMap.date) || null,
      source: 'csv',
    });
  }
  return { records, errors };
}

function parseXLSX(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ';' });
  const result = parseCSV(csv);
  result.records.forEach(r => { r.source = 'xlsx'; });
  return result;
}

async function enrichWithTerritory(records) {
  return Promise.all(records.map(async (r) => ({
    ...r,
    territory: await classifyTerritory(r.country),
  })));
}

module.exports = { parseCSV, parseXLSX, enrichWithTerritory };
