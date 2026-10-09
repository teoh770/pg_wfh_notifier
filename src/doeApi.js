export async function fetchHourly(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();
    const rows = Array.isArray(json?.api_table_hourly) ? json.api_table_hourly : [];
    return rows.map(normalizeRow).filter((r) => r.stationId && r.datetimeLocal);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRow(row) {
  return {
    stationId: row.STATION_ID ?? null,
    datetimeLocal: row.DATETIME ?? null,
    apiValue: parseApiValue(row.API),
    paramSymbol: row.PARAM_SYMBOL ?? null,
    stationLocation: row.STATION_LOCATION ?? null,
  };
}

function parseApiValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
