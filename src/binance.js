const axios = require('axios');
const crypto = require('crypto');

// Binance DAPI: coin-margined futures (colateral en BTC)
const BASE_URL = 'https://dapi.binance.com';
const symbolRulesCache = new Map();

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getStepDecimals(stepSize) {
  const text = String(stepSize);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

function isMultipleOfStep(quantity, stepSize) {
  if (!Number.isFinite(stepSize) || stepSize <= 0) return true;
  const decimals = getStepDecimals(stepSize);
  const scale = 10 ** Math.min(decimals + 2, 10);
  const q = Math.round(quantity * scale);
  const s = Math.round(stepSize * scale);
  return s > 0 ? q % s === 0 : true;
}

function floorToStep(quantity, stepSize) {
  if (!Number.isFinite(stepSize) || stepSize <= 0) return quantity;
  const steps = Math.floor(quantity / stepSize);
  const adjusted = steps * stepSize;
  const decimals = getStepDecimals(stepSize);
  return Number(adjusted.toFixed(Math.min(decimals, 8)));
}

function getApiCredentials() {
  return {
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
  };
}

function buildSignedQuery(params, apiSecret) {
  const query = new URLSearchParams({
    ...params,
    recvWindow: 5000,
    timestamp: Date.now(),
  }).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function signedRequest(method, path, params = {}) {
  const { apiKey, apiSecret } = getApiCredentials();
  if (!apiKey || !apiSecret) {
    throw new Error('Faltan BINANCE_API_KEY o BINANCE_API_SECRET en .env');
  }

  const query = buildSignedQuery(params, apiSecret);
  const url = `${BASE_URL}${path}?${query}`;

  const { data } = await axios({
    method,
    url,
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 10000,
  });

  return data;
}

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

/**
 * Obtiene la posición abierta real en Binance para el símbolo.
 * Retorna la cantidad absoluta de contratos abiertos en long/short según el signo.
 */
async function getOpenPositionQuantity(symbol) {
  const data = await signedRequest('GET', '/dapi/v1/positionRisk', {
    symbol,
  });

  const positionInfo = Array.isArray(data) ? data.find((entry) => entry.symbol === symbol) : data;
  if (!positionInfo) {
    return 0;
  }

  const positionAmt = Math.abs(toNumber(positionInfo.positionAmt, 0));
  return positionAmt;
}

/**
 * Obtiene reglas de mercado para validar quantity en órdenes MARKET de DAPI.
 */
async function getSymbolMarketRules(symbol, forceRefresh = false) {
  if (!forceRefresh && symbolRulesCache.has(symbol)) {
    return symbolRulesCache.get(symbol);
  }

  const { data } = await axios.get(`${BASE_URL}/dapi/v1/exchangeInfo`, {
    params: { symbol },
    timeout: 10000,
  });

  const symbolInfo = data?.symbols?.find((s) => s.symbol === symbol);
  if (!symbolInfo) {
    throw new Error(`No se encontró metadata del símbolo ${symbol} en exchangeInfo`);
  }

  const marketLot = symbolInfo.filters?.find((f) => f.filterType === 'MARKET_LOT_SIZE');
  const lot = symbolInfo.filters?.find((f) => f.filterType === 'LOT_SIZE');
  const qtyFilter = marketLot || lot;

  if (!qtyFilter) {
    throw new Error(`No se encontró filtro de cantidad para ${symbol}`);
  }

  const rules = {
    symbol,
    minQty: toNumber(qtyFilter.minQty, 0),
    maxQty: toNumber(qtyFilter.maxQty, Number.POSITIVE_INFINITY),
    stepSize: toNumber(qtyFilter.stepSize, 1),
    filterType: qtyFilter.filterType,
  };

  symbolRulesCache.set(symbol, rules);
  return rules;
}

/**
 * Valida quantity para MARKET usando los filtros del exchange.
 * No corrige automáticamente para evitar desincronización del estado interno.
 */
async function validateMarketOrderQuantity(symbol, quantity, options = {}) {
  const rules = await getSymbolMarketRules(symbol, options.forceRefresh);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return {
      ok: false,
      reason: `Cantidad inválida para ${symbol}: ${quantity}`,
      rules,
    };
  }

  if (quantity < rules.minQty) {
    return {
      ok: false,
      reason: `Cantidad ${quantity} < minQty ${rules.minQty} (${rules.filterType})`,
      rules,
    };
  }

  if (quantity > rules.maxQty) {
    return {
      ok: false,
      reason: `Cantidad ${quantity} > maxQty ${rules.maxQty} (${rules.filterType})`,
      rules,
    };
  }

  if (!isMultipleOfStep(quantity, rules.stepSize)) {
    return {
      ok: false,
      reason: `Cantidad ${quantity} no respeta stepSize ${rules.stepSize} (${rules.filterType})`,
      rules,
    };
  }

  return { ok: true, quantity, rules };
}

/**
 * Ajusta quantity para intentar cumplir filtros MARKET de Binance.
 * - Capea al maxQty
 * - Ajusta hacia abajo al stepSize
 * - Si queda debajo de minQty, rechaza
 */
async function sanitizeMarketOrderQuantity(symbol, desiredQty, options = {}) {
  const rules = await getSymbolMarketRules(symbol, options.forceRefresh);
  if (!Number.isFinite(desiredQty) || desiredQty <= 0) {
    return { ok: false, reason: `Cantidad inválida para ${symbol}: ${desiredQty}`, rules };
  }

  let quantity = desiredQty;
  const notes = [];

  if (quantity > rules.maxQty) {
    quantity = rules.maxQty;
    notes.push(`cap maxQty=${rules.maxQty}`);
  }

  const stepped = floorToStep(quantity, rules.stepSize);
  if (stepped !== quantity) {
    quantity = stepped;
    notes.push(`ajuste stepSize=${rules.stepSize}`);
  }

  if (quantity < rules.minQty) {
    return {
      ok: false,
      reason: `Luego de ajustar, ${quantity} < minQty ${rules.minQty} (${rules.filterType})`,
      rules,
      desiredQty,
      adjustedQty: quantity,
      notes,
    };
  }

  if (!isMultipleOfStep(quantity, rules.stepSize)) {
    return {
      ok: false,
      reason: `Cantidad ${quantity} no respeta stepSize ${rules.stepSize} (${rules.filterType})`,
      rules,
      desiredQty,
      adjustedQty: quantity,
      notes,
    };
  }

  return {
    ok: true,
    desiredQty,
    quantity,
    adjusted: quantity !== desiredQty,
    notes,
    rules,
  };
}

/**
 * Configura el apalancamiento del símbolo para futuros coin-margined.
 * Binance permite un leverage por símbolo/cuenta.
 */
async function ensureLeverage(symbol, leverage) {
  return signedRequest('POST', '/dapi/v1/leverage', {
    symbol,
    leverage,
  });
}

/**
 * Ejecuta una orden MARKET en coin-margined futures.
 * @param {string} symbol
 * @param {'BUY'|'SELL'} side
 * @param {number} quantity - Cantidad de contratos
 * @param {{ reduceOnly?: boolean, clientOrderId?: string }} options
 */
async function placeMarketOrder(symbol, side, quantity, options = {}) {
  const sanitized = await sanitizeMarketOrderQuantity(symbol, quantity, options);
  if (!sanitized.ok) {
    throw new Error(`Filtro Binance rechazó orden ${symbol} ${side}: ${sanitized.reason}`);
  }

  const params = {
    symbol,
    side,
    type: 'MARKET',
    quantity: sanitized.quantity,
  };

  if (options.reduceOnly) {
    params.reduceOnly = 'true';
  }
  if (options.clientOrderId) {
    params.newClientOrderId = options.clientOrderId;
  }

  const data = await signedRequest('POST', '/dapi/v1/order', params);
  return {
    ...data,
    requestedQuantity: sanitized.desiredQty,
    sentQuantity: sanitized.quantity,
    quantityAdjusted: sanitized.adjusted,
    adjustmentNotes: sanitized.notes,
  };
}

module.exports = {
  getPrice,
  getKlines,
  getOpenPositionQuantity,
  getSymbolMarketRules,
  validateMarketOrderQuantity,
  sanitizeMarketOrderQuantity,
  ensureLeverage,
  placeMarketOrder,
};
