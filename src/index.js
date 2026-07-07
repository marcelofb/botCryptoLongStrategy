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
const symbol = config.symbol;
const tradingEnabled = String(process.env.TRADING_ENABLED || 'false').toLowerCase() === 'true';

function ensureTradingConfig() {
  if (!tradingEnabled) return;
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
    throw new Error('TRADING_ENABLED=true pero faltan BINANCE_API_KEY o BINANCE_API_SECRET en .env');
  }
}

function buildClientOrderId(prefix, symbol) {
  const ts = Date.now();
  return `${prefix}-${symbol}-${ts}`.slice(0, 36);
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getExecutedContracts(order, fallback) {
  return toFiniteNumber(order?.executedQty, toFiniteNumber(order?.cumQty, fallback));
}

function getExecutedAvgPrice(order, fallbackPrice) {
  const avg = toFiniteNumber(order?.avgPrice, null);
  return avg && avg > 0 ? avg : fallbackPrice;
}

async function closePositionFully(symbol, positionToClose, price, maxAttempts = 3) {
  let totalClosedContracts = 0;
  let lastOrder = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const realOpenContracts = await binance.getOpenPositionQuantity(symbol);
    if (realOpenContracts <= 0) {
      return {
        closedFully: true,
        totalClosedContracts,
        remainingContracts: 0,
        lastOrder,
      };
    }

    const order = await binance.placeMarketOrder(symbol, 'SELL', realOpenContracts, {
      reduceOnly: true,
      clientOrderId: buildClientOrderId(`tpclose${attempt}`, symbol),
    });

    if (order.quantityAdjusted) {
      console.log(`  ℹ️ TP CLOSE ajustada por filtros ${symbol}: ${order.requestedQuantity} → ${order.sentQuantity} (${order.adjustmentNotes.join(', ')})`);
    }

    const filledCloseQty = getExecutedContracts(order, order.sentQuantity);
    if (!filledCloseQty || filledCloseQty <= 0) {
      throw new Error(`TP CLOSE sin ejecución confirmada para ${symbol} (orderId=${order.orderId})`);
    }

    lastOrder = order;
    totalClosedContracts += filledCloseQty;
    const remainingContracts = await binance.getOpenPositionQuantity(symbol);

    console.log(`  ✅ Orden TP CLOSE ejecutada ${symbol}: side=SELL qty=${filledCloseQty} orderId=${order.orderId}`);

    if (remainingContracts > 0) {
      console.log(`  ↻ TP parcial detectado en ${symbol}: quedan ${remainingContracts} contratos, reintentando cierre...`);
    } else {
      return {
        closedFully: true,
        totalClosedContracts,
        remainingContracts: 0,
        lastOrder,
      };
    }
  }

  const remainingContracts = await binance.getOpenPositionQuantity(symbol);
  return {
    closedFully: remainingContracts <= 0,
    totalClosedContracts,
    remainingContracts,
    lastOrder,
  };
}

/**
 * Ciclo principal: evalúa cada par y envía alertas según corresponda.
 */
async function checkPairs() {
  console.log(`\n[${new Date().toLocaleString('es-ES')}] Ejecutando chequeo...`);

  try {
    await checkPair(symbol);
  } catch (err) {
    console.error(`Error chequeando ${symbol}:`, err.message);
    // En trading real evitamos reintentos automáticos para no duplicar órdenes.
    if (tradingEnabled) {
      await telegram.send(`⚠️ Error en ${symbol} con trading real habilitado: ${err.message}\nNo se reintenta automáticamente para evitar duplicar órdenes.`);
      return;
    }

    // En modo alertas sí reintentamos una vez.
    try {
      console.log(`Reintentando ${symbol}...`);
      await new Promise((r) => setTimeout(r, 5000));
      await checkPair(symbol);
    } catch (retryErr) {
      console.error(`Reintento fallido para ${symbol}:`, retryErr.message);
    }
  }
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
      const contractsPerPart = Math.max(1, Math.round((config.capitalBTC * price) / (config.totalParts * 100)));
      const initialContracts = config.initialParts * contractsPerPart;
      let executedContracts = initialContracts;
      let executedPrice = price;
      let appliedContractsPerPart = contractsPerPart;
      console.log(`  🟢 Señal de entrada detectada para ${symbol} (${analysis.strength}) — ${contractsPerPart} contratos/parte`);

      if (tradingEnabled) {
        await binance.ensureLeverage(symbol, config.leverage);
        const order = await binance.placeMarketOrder(symbol, 'BUY', initialContracts, {
          clientOrderId: buildClientOrderId('entry', symbol),
        });
        if (order.quantityAdjusted) {
          console.log(`  ℹ️ ENTRY ajustada por filtros ${symbol}: ${order.requestedQuantity} → ${order.sentQuantity} (${order.adjustmentNotes.join(', ')})`);
        }

        const filledQty = getExecutedContracts(order, order.sentQuantity);
        if (!filledQty || filledQty <= 0) {
          throw new Error(`ENTRY sin ejecución confirmada para ${symbol} (orderId=${order.orderId})`);
        }
        executedContracts = filledQty;
        executedPrice = getExecutedAvgPrice(order, price);
        appliedContractsPerPart = executedContracts / config.initialParts;
        console.log(`  ✅ Orden ENTRY ejecutada ${symbol}: side=BUY qty=${executedContracts} orderId=${order.orderId}`);
      }

      position.openPosition(
        state,
        symbol,
        executedPrice,
        appliedContractsPerPart,
        config.initialParts,
        { contracts: executedContracts, parts: config.initialParts },
      );
      await history.logOpen(symbol, executedPrice, config.initialParts, executedContracts);
      await telegram.sendEntryAlert(symbol, executedPrice, analysis, appliedContractsPerPart);
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

      let closeResult = {
        closedFully: true,
        totalClosedContracts: pos.totalContracts,
        remainingContracts: 0,
        lastOrder: null,
      };

      if (tradingEnabled) {
        closeResult = await closePositionFully(symbol, pos, price);
      }

      if (closeResult.closedFully) {
        await history.logClose(symbol, price, pos, tpResult.pnlPercent, tpResult.leveragedPnlPercent);
        await telegram.sendTPAlert(symbol, price, pos, tpResult);
        position.closePosition(state, symbol);
      } else {
        const remaining = position.getPosition(state, symbol);
        await telegram.send(`⚠️ TP no pudo cerrar completamente ${symbol}: quedaron ${closeResult.remainingContracts} contratos abiertos en Binance tras ${closeResult.totalClosedContracts} contratos cerrados.`);
        if (remaining.totalContracts <= 0) {
          position.closePosition(state, symbol);
        }
      }
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
      const contractsToAdd = dcaResult.partsToAdd * pos.contractsPerPart;
      let executedContracts = contractsToAdd;
      let executedPrice = price;
      let appliedParts = dcaResult.partsToAdd;

      if (tradingEnabled) {
        await binance.ensureLeverage(symbol, config.leverage);
        const order = await binance.placeMarketOrder(symbol, 'BUY', contractsToAdd, {
          clientOrderId: buildClientOrderId('dca', symbol),
        });
        if (order.quantityAdjusted) {
          console.log(`  ℹ️ DCA ajustada por filtros ${symbol}: ${order.requestedQuantity} → ${order.sentQuantity} (${order.adjustmentNotes.join(', ')})`);
        }

        const filledQty = getExecutedContracts(order, order.sentQuantity);
        if (!filledQty || filledQty <= 0) {
          throw new Error(`DCA sin ejecución confirmada para ${symbol} (orderId=${order.orderId})`);
        }
        executedContracts = filledQty;
        executedPrice = getExecutedAvgPrice(order, price);
        appliedParts = executedContracts / pos.contractsPerPart;
        console.log(`  ✅ Orden DCA ejecutada ${symbol}: side=BUY qty=${executedContracts} orderId=${order.orderId}`);
      }

      const avgBefore = pos.avgPrice;
      position.addEntry(state, symbol, executedPrice, appliedParts, {
        contracts: executedContracts,
        parts: appliedParts,
      });
      const updatedPos = position.getPosition(state, symbol);
      await history.logDCA(symbol, executedPrice, appliedParts, avgBefore, updatedPos.avgPrice, updatedPos.partsUsed, executedContracts);
      await telegram.sendDCAAlert(symbol, executedPrice, updatedPos, {
        ...dcaResult,
        partsToAdd: appliedParts,
      });
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

  await telegram.sendDailySummary(summaries);
}

/**
 * Punto de entrada principal.
 */
async function main() {
  ensureTradingConfig();

  if (tradingEnabled) {
    const rules = await binance.getSymbolMarketRules(symbol);
    console.log(`🔎 Filtros ${symbol}: minQty=${rules.minQty}, maxQty=${rules.maxQty}, step=${rules.stepSize} (${rules.filterType})`);
  }

  console.log('🤖 Crypto Bull Bot — Long 5x');
  console.log(`📌 Par: ${symbol}`);
  console.log(`🧭 Modo: ${tradingEnabled ? 'TRADING REAL' : 'Solo alertas (paper/simulado)'}`);
  console.log(`💰 Capital: ${config.capitalBTC} BTC`);
  console.log(`⏰ Chequeo: ${config.checkCron}`);
  console.log(`📋 Resumen diario: ${config.dailySummaryCron}`);
  console.log('');

  // Cargar estado persistido
  state = position.loadState();
  console.log('📂 Estado cargado desde disco');
  const pos = position.getPosition(state, symbol);
  console.log(`  ${symbol}: ${pos.active ? 'activa' : 'inactiva'} (${pos.partsUsed} partes, ${pos.totalContracts} contratos)`);

  // Inicializar Telegram
  telegram.init();
  await telegram.sendStartup(tradingEnabled);

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
