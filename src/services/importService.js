const XLSX = require('xlsx');
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
