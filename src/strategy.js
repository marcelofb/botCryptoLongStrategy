const config = require('../config');
const { localDateString } = require('./utils');
const { detectPullback, calcRSI } = require('./indicators');

/**
 * Calcula el PnL% de una posición long.
 * Long gana cuando el precio sube: PnL% = ((currentPrice - avgPrice) / avgPrice) × 100
 */
function calcLongPnL(avgPrice, currentPrice) {
  return ((currentPrice - avgPrice) / avgPrice) * 100;
}

/**
 * Evalúa si es momento de abrir un long basándose en indicadores técnicos.
 * @param {Array} klines - Velas históricas
 * @returns {{ shouldOpen: boolean, analysis: object }}
 */
function shouldOpenLong(klines) {
  const analysis = detectPullback(klines, config.indicators);
  const shouldOpen = analysis.signal && (analysis.strength === 'strong' || analysis.strength === 'medium');
  return { shouldOpen, analysis };
}

/**
 * Evalúa si hay que hacer DCA (agregar contratos) y cuántas partes.
 * Mismas reglas de % de pérdida en cuenta que el bear bot.
 * Límite: 1 DCA por día.
 * Momento óptimo: RSI(1h) ≤ dcaOptimal1hRSI (precio bajando = mejor entrada long más barata).
 * Fallback: si ya pasó dcaFallbackHour, ejecutar independientemente del RSI 1h.
 *
 * @param {object} position - Estado de la posición
 * @param {number} currentPrice - Precio actual del par
 * @param {Array|null} klines1h - Velas 1h para evaluar momento óptimo (opcional)
 * @returns {{ shouldDCA: boolean, partsToAdd: number, pnlPercent: number, reason: string, rsi1h: number|null }}
 */
function shouldDCA(position, currentPrice, klines1h = null) {
  if (!position || !position.active) {
    return { shouldDCA: false, partsToAdd: 0, pnlPercent: 0, reason: 'Sin posición activa', rsi1h: null };
  }

  const pnlPercent = calcLongPnL(position.avgPrice, currentPrice);
  const pnlCuenta = Math.round(pnlPercent * config.leverage * 100) / 100;
  const partsRemaining = config.totalParts - position.partsUsed;

  // Límite de 1 DCA por día (incluye el día de apertura)
  const today = localDateString();
  if (position.lastDCADate === today) {
    return { shouldDCA: false, partsToAdd: 0, pnlPercent: pnlCuenta, reason: `Ya se realizó 1 DCA hoy (${today})`, rsi1h: null };
  }

  // Si está en ganancia, no hacer DCA
  if (pnlPercent >= 0) {
    return { shouldDCA: false, partsToAdd: 0, pnlPercent: pnlCuenta, reason: 'Posición en ganancia, no se opera', rsi1h: null };
  }

  // Si no quedan partes, no se puede hacer DCA
  if (partsRemaining <= 0) {
    return { shouldDCA: false, partsToAdd: 0, pnlPercent: pnlCuenta, reason: 'No quedan partes disponibles', rsi1h: null };
  }

  // Momento óptimo para long: RSI 1h ≤ umbral (precio con impulso bajista = más barato = mejor entrada)
  // Fallback: si ya pasó la hora límite del día, ejecutar igual independientemente del RSI 1h
  const currentHour = new Date().getHours();
  const fallbackActive = currentHour >= config.dcaFallbackHour;

  let rsi1h = null;
  if (klines1h && klines1h.length > 14) {
    const closes1h = klines1h.map((k) => k.close);
    const rsiValues = calcRSI(closes1h, 14);
    rsi1h = Math.round(rsiValues[rsiValues.length - 1] * 100) / 100;
    if (rsi1h > config.dcaOptimal1hRSI && !fallbackActive) {
      return {
        shouldDCA: false, partsToAdd: 0, pnlPercent: pnlCuenta,
        reason: `Esperando momento óptimo: RSI 1h ${rsi1h} > ${config.dcaOptimal1hRSI} (precio con impulso alcista, esperar retroceso)`,
        rsi1h,
      };
    }
  }

  // Determinar partes según reglas de DCA (PnL en cuenta = precio × leverage)
  let partsToAdd = 0;
  for (const rule of config.dcaRules) {
    if (pnlCuenta >= rule.maxLoss) {
      partsToAdd = rule.parts;
      break;
    }
  }

  partsToAdd = Math.min(partsToAdd, partsRemaining);

  const fallbackNote = fallbackActive && rsi1h !== null && rsi1h > config.dcaOptimal1hRSI ? ' [fallback horario]' : '';
  return {
    shouldDCA: partsToAdd > 0,
    partsToAdd,
    pnlPercent: pnlCuenta,
    reason: `PnL cuenta: ${pnlCuenta.toFixed(2)}% → agregar ${partsToAdd} partes${rsi1h !== null ? ` (RSI 1h: ${rsi1h})` : ''}${fallbackNote}`,
    rsi1h,
  };
}

/**
 * Evalúa si se alcanzó el Take Profit (+15% ganancia en cuenta = 3% subida de precio a 5x).
 * Para long: ganancia cuando el precio sube respecto al precio promedio de entrada.
 *
 * @param {object} position - Estado de la posición
 * @param {number} currentPrice - Precio actual
 * @returns {{ shouldTP: boolean, pnlPercent: number, leveragedPnlPercent: number, estimatedProfitBTC: number }}
 */
function shouldTakeProfit(position, currentPrice) {
  if (!position || !position.active) {
    return { shouldTP: false, pnlPercent: 0, leveragedPnlPercent: 0, estimatedProfitBTC: 0 };
  }

  const pnlPercent = calcLongPnL(position.avgPrice, currentPrice);
  const leveragedPnlPercent = Math.round(pnlPercent * config.leverage * 100) / 100;
  // Ganancia en BTC = (pnl% × notional_USD × leverage) / precio_actual
  const notionalUSD = position.totalContracts * 100;
  const estimatedProfitBTC = (pnlPercent / 100) * notionalUSD * config.leverage / currentPrice;

  return {
    shouldTP: pnlPercent >= config.takeProfitPercent,
    pnlPercent,
    leveragedPnlPercent,
    estimatedProfitBTC: parseFloat(estimatedProfitBTC.toFixed(8)),
  };
}

/**
 * Verifica si la posición se acerca al precio de liquidación.
 * Para long a 5x, liquidación estimada ≈ avgPrice × 0.80 (20% debajo del promedio).
 *
 * @param {object} position - Estado de la posición
 * @param {number} currentPrice - Precio actual
 * @returns {{ isRisky: boolean, distancePercent: number, liquidationPrice: number }}
 */
function checkLiquidationRisk(position, currentPrice) {
  if (!position || !position.active) {
    return { isRisky: false, distancePercent: 100, liquidationPrice: 0 };
  }

  // Para long a 5x: liquidación ≈ avgPrice × (1 - 1/leverage) = avgPrice × 0.80
  const liquidationPrice = position.avgPrice * (1 - 1 / config.leverage);
  // Distancia: qué tan lejos está el precio actual de la liquidación (hacia abajo)
  const distancePercent = ((currentPrice - liquidationPrice) / currentPrice) * 100;

  return {
    isRisky: distancePercent <= config.liquidationAlertPercent,
    distancePercent: Math.round(distancePercent * 100) / 100,
    liquidationPrice: Math.round(liquidationPrice * 100) / 100,
  };
}

module.exports = { shouldOpenLong, shouldDCA, shouldTakeProfit, checkLiquidationRisk, calcLongPnL };
