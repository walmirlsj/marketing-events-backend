// src/services/territoryService.js
// ─────────────────────────────────────────────────────────────────
//  Territory Engine
//  Classifica automaticamente o território com base no País,
//  consultando a tabela auxiliar 'regions'.
//  Fallback: mapeamento estático em memória para alta disponibilidade.
// ─────────────────────────────────────────────────────────────────
const db = require('../config/database');

// Mapeamento estático de fallback (usado se o DB não encontrar)
const STATIC_MAP = {
  // Brazil
  'brazil': 'Brazil', 'brasil': 'Brazil',
  // Mexico
  'mexico': 'Mexico', 'méxico': 'Mexico',
  // NOLA
  'colombia': 'NOLA', 'venezuela': 'NOLA', 'ecuador': 'NOLA',
  'panama': 'NOLA', 'costa rica': 'NOLA', 'guatemala': 'NOLA',
  'honduras': 'NOLA', 'el salvador': 'NOLA', 'nicaragua': 'NOLA',
  'dominican republic': 'NOLA', 'republica dominicana': 'NOLA',
  'cuba': 'NOLA', 'haiti': 'NOLA', 'jamaica': 'NOLA',
  'trinidad and tobago': 'NOLA', 'bolivia': 'NOLA', 'puerto rico': 'NOLA',
  // SOLA
  'argentina': 'SOLA', 'chile': 'SOLA', 'uruguay': 'SOLA',
  'paraguay': 'SOLA', 'peru': 'SOLA',
};

/**
 * Classifica o território com base no nome do país.
 * 1. Consulta a tabela 'regions' no banco de dados.
 * 2. Se não encontrar, usa o mapeamento estático.
 * 3. Se não encontrar em nenhum, retorna null.
 *
 * @param {string} countryName - Nome do país
 * @returns {Promise<string|null>} - Território: 'Brazil' | 'Mexico' | 'NOLA' | 'SOLA' | null
 */
async function classifyTerritory(countryName) {
  if (!countryName) return null;

  const normalized = countryName.trim();

  try {
    // Consulta DB com busca case-insensitive
    const { rows } = await db.query(
      `SELECT territory FROM regions
       WHERE LOWER(country_name) = LOWER($1)
       LIMIT 1`,
      [normalized]
    );

    if (rows.length > 0) {
      return rows[0].territory;
    }

    // Partial match: busca se o nome contém o país
    const { rows: partialRows } = await db.query(
      `SELECT territory FROM regions
       WHERE LOWER($1) LIKE CONCAT('%', LOWER(country_name), '%')
       OR LOWER(country_name) LIKE CONCAT('%', LOWER($1), '%')
       LIMIT 1`,
      [normalized]
    );

    if (partialRows.length > 0) {
      return partialRows[0].territory;
    }
  } catch (err) {
    console.error('[TerritoryService] DB lookup failed, using static map:', err.message);
  }

  // Fallback: mapeamento estático
  return STATIC_MAP[normalized.toLowerCase()] || null;
}

/**
 * Importa um CSV de regiões (separador: ponto e vírgula)
 * Formato esperado das linhas: country_name;territory
 * ou: country_name;country_code;territory
 *
 * @param {string} csvContent - Conteúdo do arquivo CSV em string
 * @returns {Promise<{ inserted: number, errors: string[] }>}
 */
async function importRegionsFromCSV(csvContent) {
  const lines = csvContent.split('\n').map(l => l.trim()).filter(Boolean);
  let inserted = 0;
  const errors = [];

  // Pula cabeçalho se existir
  const dataLines = lines[0].toLowerCase().includes('country') ? lines.slice(1) : lines;

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
        errors.push(`Linha inválida (esperado 2 ou 3 colunas separadas por ;): "${line}"`);
        continue;
      }

      const validTerritories = ['Brazil', 'Mexico', 'NOLA', 'SOLA'];
      if (!validTerritories.includes(territory)) {
        errors.push(`Território inválido "${territory}" para país "${countryName}". Use: ${validTerritories.join(', ')}`);
        continue;
      }

      await client.query(
        `INSERT INTO regions (country_name, country_code, territory)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
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

/**
 * Lista todos os mapeamentos de regiões do banco de dados.
 */
async function listRegions() {
  const { rows } = await db.query(
    `SELECT id, country_name, country_code, territory
     FROM regions
     ORDER BY territory, country_name`
  );
  return rows;
}

module.exports = { classifyTerritory, importRegionsFromCSV, listRegions };
