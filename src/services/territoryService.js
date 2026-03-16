const db = require('../config/database');

const STATIC_MAP = {
  'brazil': 'Brazil', 'brasil': 'Brazil',
  'mexico': 'Mexico', 'méxico': 'Mexico',
  'colombia': 'NOLA', 'venezuela': 'NOLA', 'ecuador': 'NOLA',
  'panama': 'NOLA', 'costa rica': 'NOLA', 'guatemala': 'NOLA',
  'honduras': 'NOLA', 'el salvador': 'NOLA', 'nicaragua': 'NOLA',
  'dominican republic': 'NOLA', 'republica dominicana': 'NOLA',
  'cuba': 'NOLA', 'haiti': 'NOLA', 'jamaica': 'NOLA',
  'trinidad and tobago': 'NOLA', 'bolivia': 'NOLA', 'puerto rico': 'NOLA',
  'argentina': 'SOLA', 'chile': 'SOLA', 'uruguay': 'SOLA',
  'paraguay': 'SOLA', 'peru': 'SOLA',
};

async function classifyTerritory(countryName) {
  if (!countryName) return null;
  const normalized = countryName.trim();

  try {
    const { rows } = await db.query(
      `SELECT territory FROM regions
       WHERE LOWER(country_name) = LOWER($1) LIMIT 1`,
      [normalized]
    );
    if (rows.length > 0) return rows[0].territory;

    const { rows: partialRows } = await db.query(
      `SELECT territory FROM regions
       WHERE LOWER($1) LIKE CONCAT('%', LOWER(country_name), '%')
       OR LOWER(country_name) LIKE CONCAT('%', LOWER($1), '%')
       LIMIT 1`,
      [normalized]
    );
    if (partialRows.length > 0) return partialRows[0].territory;
  } catch (err) {
    console.error('[TerritoryService] DB lookup failed:', err.message);
  }

  return STATIC_MAP[normalized.toLowerCase()] || null;
}

async function importRegionsFromCSV(csvContent) {
  const lines = csvContent.split('\n').map(l => l.trim()).filter(Boolean);
  const dataLines = lines[0].toLowerCase().includes('country') ? lines.slice(1) : lines;
  let inserted = 0;
  const errors = [];

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    for (const line of dataLines) {
      const parts = line.split(';').map(p => p.trim());
      let countryName, countryCode, territory;

      if (parts.length === 3) {
        [countryName, countryCode, territory] = parts;
      } else if (parts.length === 2) {
        [countryName, territory] = parts;
        countryCode = null;
      } else {
        errors.push(`Linha inválida: "${line}"`);
        continue;
      }

      const validTerritories = ['Brazil', 'Mexico', 'NOLA', 'SOLA'];
      if (!validTerritories.includes(territory)) {
        errors.push(`Território inválido "${territory}" para "${countryName}"`);
        continue;
      }

      await client.query(
        `INSERT INTO regions (country_name, country_code, territory)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [countryName, countryCode || null, territory]
      );
      inserted++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { inserted, errors };
}

async function listRegions() {
  const { rows } = await db.query(
    `SELECT id, country_name, country_code, territory
     FROM regions ORDER BY territory, country_name`
  );
  return rows;
}

module.exports = { classifyTerritory, importRegionsFromCSV, listRegions };
