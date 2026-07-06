require('dotenv').config();
const cron = require('node-cron');
const config = require('../config');
const binance = require('./binance');
const strategy = require('./strategy');
const position = require('./position');
const telegram = require('./telegram');
const history = require('./history');
const { calcLongPnL } = require('./strategy');

// Estado global
let state = null;

/**
 * Ciclo principal: evalúa cada par y envía alertas según corresponda.
 */
async function checkPairs() {
  console.log(`\n[${new Date().toLocaleString('es-ES')}] Ejecutando chequeo...`);

  await Promise.all(config.pairs.map(async (symbol) => {
    try {
      await checkPair(symbol);
    } catch (err) {
      console.error(`Error chequeando ${symbol}:`, err.message);
      // Reintento una vez
      try {
        console.log(`Reintentando ${symbol}...`);
        await new Promise((r) => setTimeout(r, 5000));
        await checkPair(symbol);
      } catch (retryErr) {
        console.error(`Reintento fallido para ${symbol}:`, retryErr.message);
      }
    }
  }));
}

/**
 * Evalúa un par individual.
 */
async function checkPair(symbol) {
  const pos = position.getPosition(state, symbol);

  const [price, klines] = await Promise.all([
    binance.getPrice(symbol),
    binance.getKlines(symbol, config.indicators.timeframe, config.indicators.klinesLimit),
  ]);

  // Fetch klines 1h adicionales solo si hay posición activa (para momento óptimo de DCA)
  let klines1h = null;
  if (pos.active) {
    try {
      klines1h = await binance.getKlines(symbol, '1h', 50);
    } catch (err) {
      console.warn(`  ⚠️ No se pudo obtener klines 1h para ${symbol}:`, err.message);
    }
  }

  console.log(`  ${symbol}: precio=$${price}, posición=${pos.active ? 'activa' : 'inactiva'}, partes=${pos.partsUsed}/${config.totalParts}`);

  if (!pos.active) {
    // --- No hay posición abierta: buscar señal de entrada ---
    const { shouldOpen, analysis } = strategy.shouldOpenLong(klines);
    if (shouldOpen) {
      // Calcular contractsPerPart al momento de abrir y congelarlo en la posición
      const contractsPerPart = Math.max(1, Math.round((config.capitalPerPairBTC * price) / (config.totalParts * 100)));
      console.log(`  🟢 Señal de entrada detectada para ${symbol} (${analysis.strength}) — ${contractsPerPart} contratos/parte`);
      position.openPosition(state, symbol, price, contractsPerPart);
      await history.logOpen(symbol, price, config.initialParts);
      await telegram.sendEntryAlert(symbol, price, analysis, contractsPerPart);
    } else {
      const rsiTarget = config.indicators.rsiEntryThreshold;
      const rsiGap = (analysis.rsi - rsiTarget).toFixed(1);
      const emaGapPercent = (((price - analysis.ema) / analysis.ema) * 100).toFixed(2);
      const rsiStatus = analysis.rsi <= rsiTarget
        ? '✅ RSI OK'
        : `❌ RSI ${analysis.rsi} (faltan ${rsiGap} pts para bajar a ${rsiTarget})`;
      const emaStatus = price < analysis.ema
        ? '✅ Precio bajo EMA'
        : `❌ Precio sobre EMA (+${Math.abs(emaGapPercent)}%)`;
      console.log(`  ⏳ Sin señal para ${symbol}: ${rsiStatus} | ${emaStatus}`);
    }
  } else {
    // --- Posición activa: evaluar TP, riesgo y DCA ---
    const pnlActual = calcLongPnL(pos.avgPrice, price);
    const pnlCuenta = pnlActual * config.leverage;
    const pnlEmoji = pnlCuenta >= 0 ? '🟢' : '🔴';
    const liqPrice = (pos.avgPrice * (1 - 1 / config.leverage)).toFixed(2);
    console.log(`  ${pnlEmoji} ${symbol} — PnL cuenta: ${pnlCuenta.toFixed(2)}% (precio: ${pnlActual.toFixed(2)}%) | precio: $${price} | avg: $${pos.avgPrice} | contratos: ${pos.totalContracts} | liq. est.: $${liqPrice}`);

    // 1. ¿Take Profit alcanzado?
    const tpResult = strategy.shouldTakeProfit(pos, price);
    if (tpResult.shouldTP) {
      console.log(`  ✅ TP alcanzado para ${symbol}: ${tpResult.leveragedPnlPercent.toFixed(2)}% cuenta (${tpResult.pnlPercent.toFixed(2)}% precio)`);
      await history.logClose(symbol, price, pos, tpResult.pnlPercent, tpResult.leveragedPnlPercent);
      await telegram.sendTPAlert(symbol, price, pos, tpResult);
      position.closePosition(state, symbol);
      return; // No evaluar más
    }

    // 2. ¿Riesgo de liquidación?
    const riskResult = strategy.checkLiquidationRisk(pos, price);
    if (riskResult.isRisky) {
      console.log(`  ⚠️ Riesgo de liquidación para ${symbol}: ${riskResult.distancePercent}%`);
      const pnl = calcLongPnL(pos.avgPrice, price);
      await telegram.sendRiskAlert(symbol, price, pos, { ...riskResult, pnlPercent: pnl * config.leverage });
    }

    // 3. ¿DCA necesario?
    const dcaResult = strategy.shouldDCA(pos, price, klines1h);
    if (dcaResult.shouldDCA) {
      const rsiTag = dcaResult.rsi1h !== null ? ` | RSI 1h: ${dcaResult.rsi1h}` : '';
      console.log(`  🔄 DCA para ${symbol}: agregar ${dcaResult.partsToAdd} partes${rsiTag}`);
      const avgBefore = pos.avgPrice;
      position.addEntry(state, symbol, price, dcaResult.partsToAdd);
      const updatedPos = position.getPosition(state, symbol);
      await history.logDCA(symbol, price, dcaResult.partsToAdd, avgBefore, updatedPos.avgPrice, updatedPos.partsUsed);
      await telegram.sendDCAAlert(symbol, price, updatedPos, dcaResult);
    } else if (dcaResult.reason) {
      const rsiTag = dcaResult.rsi1h !== null ? ` (RSI 1h: ${dcaResult.rsi1h})` : '';
      console.log(`  ⏸ DCA bloqueado para ${symbol}: ${dcaResult.reason}${rsiTag}`);
    }
  }
}

/**
 * Genera y envía resumen diario de todas las posiciones.
 */
async function sendDailySummary() {
  console.log(`\n[${new Date().toLocaleString('es-ES')}] Enviando resumen diario...`);

  const summaries = [];

  for (const symbol of config.pairs) {
    const pos = position.getPosition(state, symbol);
    let currentPrice = 0;
    try {
      currentPrice = await binance.getPrice(symbol);
    } catch (err) {
      console.error(`Error obteniendo precio de ${symbol}:`, err.message);
    }

    if (pos.active) {
      const pnlPercent = calcLongPnL(pos.avgPrice, currentPrice);
      const liquidationPrice = pos.avgPrice * (1 - 1 / config.leverage);
      summaries.push({
        symbol,
        active: true,
        currentPrice,
        avgPrice: pos.avgPrice,
        pnlPercent: Math.round(pnlPercent * config.leverage * 100) / 100,
        partsUsed: pos.partsUsed,
        totalContracts: pos.totalContracts,
        totalInvested: pos.totalInvested,
        liquidationPrice: Math.round(liquidationPrice * 100) / 100,
      });
    } else {
      summaries.push({ symbol, active: false, currentPrice });
    }
  }

  await telegram.sendDailySummary(summaries);
}

/**
 * Punto de entrada principal.
 */
async function main() {
  console.log('🤖 Crypto Bull Bot — Long 5x');
  console.log(`📌 Par: ${config.pairs.join(', ')}`);
  console.log(`💰 Capital: ${config.capitalPerPairBTC} BTC por par`);
  console.log(`⏰ Chequeo: ${config.checkCron}`);
  console.log(`📋 Resumen diario: ${config.dailySummaryCron}`);
  console.log('');

  // Cargar estado persistido
  state = position.loadState();
  console.log('📂 Estado cargado desde disco');
  for (const symbol of config.pairs) {
    const pos = position.getPosition(state, symbol);
    console.log(`  ${symbol}: ${pos.active ? 'activa' : 'inactiva'} (${pos.partsUsed} partes, ${pos.totalContracts} contratos)`);
  }

  // Inicializar Telegram
  telegram.init();
  await telegram.sendStartup();

  // Chequeo inicial al arrancar
  await checkPairs();

  // Cron: chequeo según `config.checkCron` (por defecto cada 1 hora)
  cron.schedule(config.checkCron, async () => {
    try {
      await checkPairs();
    } catch (err) {
      console.error('Error en chequeo programado:', err.message);
    }
  });

  // Cron: resumen diario a las 22:00
  cron.schedule(config.dailySummaryCron, async () => {
    try {
      await sendDailySummary();
    } catch (err) {
      console.error('Error en resumen diario:', err.message);
    }
  });
}

main().catch((err) => {
  console.error('Error fatal al iniciar:', err.message);
  process.exit(1);
});
