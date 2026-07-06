const axios = require('axios');

// Binance DAPI: coin-margined futures (colateral en BTC)
const BASE_URL = 'https://dapi.binance.com';

/**
 * Obtiene el precio actual de un par coin-margined.
 * @param {string} symbol - Ej: 'BTCUSD_PERP'
 * @returns {Promise<number>}
 */
async function getPrice(symbol) {
  const { data } = await axios.get(`${BASE_URL}/dapi/v1/ticker/price`, {
    params: { symbol },
    timeout: 10000,
  });
  // DAPI devuelve un array, a diferencia de la API spot que devuelve un objeto
  const entry = Array.isArray(data) ? data[0] : data;
  return parseFloat(entry.price);
}

/**
 * Obtiene velas (klines) históricas de coin-margined futures.
 * @param {string} symbol - Ej: 'BTCUSD_PERP'
 * @param {string} interval - Ej: '4h', '1h', '1d'
 * @param {number} limit - Cantidad de velas
 * @returns {Promise<Array>} Array de objetos { openTime, open, high, low, close, volume, closeTime }
 */
async function getKlines(symbol, interval, limit = 100) {
  const { data } = await axios.get(`${BASE_URL}/dapi/v1/klines`, {
    params: { symbol, interval, limit },
    timeout: 10000,
  });
  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

module.exports = { getPrice, getKlines };
