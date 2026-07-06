const { RSI, EMA } = require('technicalindicators');

/**
 * Calcula RSI sobre un array de precios de cierre.
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]}
 */
function calcRSI(closes, period = 14) {
  return RSI.calculate({ values: closes, period });
}

/**
 * Calcula EMA sobre un array de precios de cierre.
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]}
 */
function calcEMA(closes, period = 20) {
  return EMA.calculate({ values: closes, period });
}

/**
 * Detecta si hay un pullback bajista en un uptrend (bueno para abrir long).
 * Señal: RSI ≤ `rsiEntryThreshold` (configurable, por defecto 60) indica que el precio
 * retrocedió lo suficiente en una tendencia alcista → oportunidad de compra.
 * Señal fuerte: además el precio está por debajo de la EMA20 (pullback más profundo).
 *
 * @param {Array} klines - Velas de Binance
 * @param {object} config - { rsiPeriod, rsiEntryThreshold, emaPeriod }
 * @returns {{ signal: boolean, rsi: number, ema: number, price: number, strength: string, priceBelowEMA: boolean }}
 */
function detectPullback(klines, config) {
  const closes = klines.map((k) => k.close);
  const { rsiPeriod = 14, rsiEntryThreshold = 60, emaPeriod = 20 } = config;

  const rsiValues = calcRSI(closes, rsiPeriod);
  const emaValues = calcEMA(closes, emaPeriod);

  const currentRSI = rsiValues[rsiValues.length - 1];
  const previousRSI = rsiValues[rsiValues.length - 2];
  const currentEMA = emaValues[emaValues.length - 1];
  const currentPrice = closes[closes.length - 1];

  const rsiRetrace = currentRSI <= rsiEntryThreshold;
  const priceBelowEMA = currentPrice < currentEMA;

  // Señal fuerte: RSI en retroceso + precio por debajo de EMA (pullback profundo en uptrend)
  // Señal media: solo RSI en retroceso
  // Sin señal: RSI elevado (precio con momentum alcista, no es buen entry)
  let signal = false;
  let strength = 'none';

  if (rsiRetrace && priceBelowEMA) {
    signal = true;
    strength = 'strong';
  } else if (rsiRetrace) {
    signal = true;
    strength = 'medium';
  }

  return {
    signal,
    strength,
    rsi: Math.round(currentRSI * 100) / 100,
    previousRSI: Math.round(previousRSI * 100) / 100,
    ema: Math.round(currentEMA * 100) / 100,
    price: currentPrice,
    priceBelowEMA,
  };
}

module.exports = { calcRSI, calcEMA, detectPullback };
