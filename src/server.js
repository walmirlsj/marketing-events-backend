require('dotenv').config();
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', routes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, _next) => {
  console.error('[Server Error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
});

async function runMigrations() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log('🔄 Running migrations...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS regions (
        id SERIAL PRIMARY KEY,
        country_name VARCHAR(255) NOT NULL,
        country_code VARCHAR(10),
        territory VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        name VARCHAR(500) NOT NULL,
        description TEXT,
        city VARCHAR(255) NOT NULL,
        country VARCHAR(255) NOT NULL,
        territory VARCHAR(100),
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        event_date DATE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        rejection_reason TEXT,
        source VARCHAR(50) DEFAULT 'manual',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS event_guests (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        guest_name VARCHAR(500) NOT NULL,
        guest_email VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        type VARCHAR(100) NOT NULL,
        title VARCHAR(500) NOT NULL,
        message TEXT,
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin123', 12);
    await client.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ('Admin', 'admin@marketingevents.com', $1, 'admin')
      ON CONFLICT (email) DO NOTHING
    `, [hash]);

    const { rows: existingRegions } = await client.query('SELECT COUNT(*) FROM regions');
    if (parseInt(existingRegions[0].count) === 0) {
      const regions = [
        ['Brazil','BR','Brazil'],['Brasil','BR','Brazil'],
        ['Mexico','MX','Mexico'],['México','MX','Mexico'],
        ['Colombia','CO','NOLA'],['Venezuela','VE','NOLA'],
        ['Ecuador','EC','NOLA'],['Panama','PA','NOLA'],
        ['Costa Rica','CR','NOLA'],['Guatemala','GT','NOLA'],
        ['Honduras','HN','NOLA'],['El Salvador','SV','NOLA'],
        ['Nicaragua','NI','NOLA'],['Dominican Republic','DO','NOLA'],
        ['Cuba','CU','NOLA'],['Haiti','HT','NOLA'],
        ['Jamaica','JM','NOLA'],['Bolivia','BO','NOLA'],
        ['Argentina','AR','SOLA'],['Chile','CL','SOLA'],
        ['Uruguay','UY','SOLA'],['Paraguay','PY','SOLA'],
        ['Peru','PE','SOLA'],
      ];
      for (const [name, code, territory] of regions) {
        await client.query(
          `INSERT INTO regions (country_name, country_code, territory) VALUES ($1, $2, $3)`,
          [name, code, territory]
        );
      }
    }

    console.log('✅ Migrations and seed completed!');
  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

async function start() {
  await runMigrations();
  app.listen(PORT, () => {
    console.log(`\n🚀 Marketing Events API running on http://localhost:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
  });
}

start();
