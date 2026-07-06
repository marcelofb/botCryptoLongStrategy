/**
 * Formatea un número como USD.
 * @param {number} value
 * @returns {string}
 */
function formatUSD(value) {
  return `$${value.toFixed(2)}`;
}

/**
 * Formatea un porcentaje con signo.
 * @param {number} value
 * @returns {string}
 */
function formatPercent(value) {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * Formatea un precio con decimales apropiados.
 * Precios > 10 → 2 decimales, < 10 → 4 decimales.
 * @param {number} value
 * @returns {string}
 */
function formatPrice(value) {
  if (value >= 10) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

/**
 * Retorna la fecha local como string YYYY-MM-DD (hora del sistema, no UTC).
 */
function localDateString() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/**
 * Retorna la fecha y hora local como string ISO sin Z (hora del sistema, no UTC).
 */
function localISOString() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace('Z', '');
}

module.exports = { formatUSD, formatPercent, formatPrice, localDateString, localISOString };
