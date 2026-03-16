require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const REGION_DATA = [
  ['Brazil', 'BR', 'Brazil'],
  ['Brasil', 'BR', 'Brazil'],
  ['Mexico', 'MX', 'Mexico'],
  ['México', 'MX', 'Mexico'],
  ['Colombia', 'CO', 'NOLA'],
  ['Venezuela', 'VE', 'NOLA'],
  ['Ecuador', 'EC', 'NOLA'],
  ['Panama', 'PA', 'NOLA'],
  ['Costa Rica', 'CR', 'NOLA'],
  ['Guatemala', 'GT', 'NOLA'],
  ['Honduras', 'HN', 'NOLA'],
  ['El Salvador', 'SV', 'NOLA'],
  ['Nicaragua', 'NI', 'NOLA'],
  ['Dominican Republic', 'DO', 'NOLA'],
  ['Cuba', 'CU', 'NOLA'],
  ['Haiti', 'HT', 'NOLA'],
  ['Jamaica', 'JM', 'NOLA'],
  ['Trinidad and Tobago', 'TT', 'NOLA'],
  ['Bolivia', 'BO', 'NOLA'],
  ['Puerto Rico', 'PR', 'NOLA'],
  ['Argentina', 'AR', 'SOLA'],
  ['Chile', 'CL', 'SOLA'],
  ['Uruguay', 'UY', 'SOLA'],
  ['Paraguay', 'PY', 'SOLA'],
  ['Peru', 'PE', 'SOLA'],
];

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Seeding regions table...');
    await client.query('DELETE FROM regions');

    for (const [country_name, country_code, territory] of REGION_DATA) {
      await client.query(
        `INSERT INTO regions (country_name, country_code, territory)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [country_name, country_code, territory]
      );
    }

    const { rows } = await client.query('SELECT COUNT(*) FROM regions');
    console.log(`✅ Seeded ${rows[0].count} region records.`);

    const hash = await bcrypt.hash('admin123', 12);
    await client.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ('Admin', 'admin@marketingevents.com', $1, 'admin')
      ON CONFLICT (email) DO NOTHING
    `, [hash]);
    console.log('✅ Admin user created: admin@marketingevents.com / admin123');

  } catch (err) {
    console.error('❌ Seed error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
