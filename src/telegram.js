const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const { formatUSD, formatPercent, formatPrice } = require('./utils');

let bot = null;
let chatIds = [];

function formatSymbol(symbol) {
  return `\`${String(symbol).replace(/`/g, '')}\``;
}

/**
 * Inicializa el bot de Telegram.
 */
function init() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const rawChatIds = process.env.TELEGRAM_CHAT_ID;

  if (!token || token === 'TU_TOKEN_AQUI') {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN no configurado en .env');
    return;
  }
  if (!rawChatIds || rawChatIds === 'TU_CHAT_ID_AQUI') {
    console.warn('⚠️  TELEGRAM_CHAT_ID no configurado en .env');
    return;
  }

  chatIds = rawChatIds.split(',').map((id) => id.trim()).filter(Boolean);
  bot = new TelegramBot(token, { polling: false });
  console.log(`✅ Telegram bot inicializado (${chatIds.length} destinatario${chatIds.length > 1 ? 's' : ''})`);
}

/**
 * Envía un mensaje por Telegram a todos los destinatarios.
 */
async function send(text) {
  if (!bot || chatIds.length === 0) {
    console.log('[Telegram desactivado]', text);
    return;
  }
  for (const id of chatIds) {
    try {
      await bot.sendMessage(id, text, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`Error enviando mensaje Telegram a ${id}:`, err.message);
    }
  }
}

/**
 * Alerta de entrada inicial (señal de long detectada).
 */
async function sendEntryAlert(symbol, price, analysis, contractsPerPart) {
  const strengthEmoji = { strong: '🟢🟢🟢', medium: '🟢🟢', weak: '🟢' };
  const initialContracts = config.initialParts * contractsPerPart;
  const notionalUSD = initialContracts * 100;

  const safeSymbol = formatSymbol(symbol);
  const text = `
🚀 *SEÑAL DE LONG - ${safeSymbol}*
${strengthEmoji[analysis.strength] || '🟢'} Fuerza: *${analysis.strength.toUpperCase()}*

📊 Precio actual: *${formatPrice(price)}*
📈 RSI(14): *${analysis.rsi}* ${analysis.rsi <= config.indicators.rsiEntryThreshold ? '(retroceso OK)' : ''}
📉 EMA(20): *${formatPrice(analysis.ema)}*
${analysis.priceBelowEMA ? '⬇️ Precio BAJO EMA ✅' : '⬆️ Precio sobre EMA'}

📦 Contratos iniciales: *${initialContracts}* (${contractsPerPart}/parte x ${config.initialParts} partes)
💵 Notional: *${formatUSD(notionalUSD)}*
📋 Apalancamiento: *${config.leverage}x*
  `.trim();

  await send(text);
}

/**
 * Alerta de DCA / momento de recargar.
 */
async function sendDCAAlert(symbol, price, position, dcaResult) {
  const contractsAdded = dcaResult.partsToAdd * position.contractsPerPart;
  const safeSymbol = formatSymbol(symbol);

  const text = `
🔄 *RECARGA DCA - ${safeSymbol}*

📊 Precio actual: *${formatPrice(price)}*
📊 Precio promedio: *${formatPrice(position.avgPrice)}*
📉 PnL: *${formatPercent(dcaResult.pnlPercent)}*

➕ Agregar: *${dcaResult.partsToAdd} partes* (${contractsAdded} contratos)
📦 Partes usadas: *${position.partsUsed}/${config.totalParts}*
📦 Total contratos: *${position.totalContracts}* (${formatUSD(position.totalInvested)} notional)
  `.trim();

  await send(text);
}

/**
 * Alerta de Take Profit alcanzado.
 */
async function sendTPAlert(symbol, price, position, tpResult) {
  const safeSymbol = formatSymbol(symbol);
  const text = `
✅ *TAKE PROFIT - ${safeSymbol}*

🎯 PnL alcanzado: *${formatPercent(tpResult.leveragedPnlPercent)}* (cuenta)
💰 Ganancia estimada: *${tpResult.estimatedProfitBTC.toFixed(6)} BTC*

📊 Precio actual: *${formatPrice(price)}*
📊 Precio promedio: *${formatPrice(position.avgPrice)}*
📦 Contratos: *${position.totalContracts}* (${formatUSD(position.totalInvested)} notional)

🟢 Se recomienda CERRAR la posición.
  `.trim();

  await send(text);
}

/**
 * Alerta de riesgo alto (cerca de liquidación por abajo).
 */
async function sendRiskAlert(symbol, price, position, riskResult) {
  const safeSymbol = formatSymbol(symbol);
  const text = `
⚠️ *ALERTA DE RIESGO - ${safeSymbol}*

🚨 Distancia a liquidación: *${formatPercent(riskResult.distancePercent)}*
💀 Precio de liquidación estimado: *${formatPrice(riskResult.liquidationPrice)}* (debajo del precio actual)

📊 Precio actual: *${formatPrice(price)}*
📊 Precio promedio: *${formatPrice(position.avgPrice)}*
📉 PnL: *${formatPercent(riskResult.pnlPercent || 0)}*
📦 Contratos: *${position.totalContracts}*

⚠️ Evalúa si conviene mantener la posición.
  `.trim();

  await send(text);
}

/**
 * Resumen diario del estado de todas las posiciones.
 */
async function sendDailySummary(positionsSummary) {
  let text = `📋 *RESUMEN DIARIO - ${new Date().toLocaleDateString('es-ES')}*\n\n`;

  for (const summary of positionsSummary) {
    const statusEmoji = summary.active ? '🟢' : '⚪';
    text += `${statusEmoji} ${formatSymbol(summary.symbol)}\n`;

    if (summary.active) {
      text += `  📊 Precio actual: ${formatPrice(summary.currentPrice)}\n`;
      text += `  📊 Precio promedio: ${formatPrice(summary.avgPrice)}\n`;
      text += `  📈 PnL: ${formatPercent(summary.pnlPercent)}\n`;
      text += `  📦 Partes: ${summary.partsUsed}/${config.totalParts} (${summary.totalContracts} contratos)\n`;
      text += `  💵 Notional: ${formatUSD(summary.totalInvested)}\n`;
      text += `  💀 Liquidación: ${formatPrice(summary.liquidationPrice)}\n`;
    } else {
      text += `  Sin posición activa\n`;
    }
    text += '\n';
  }

  await send(text.trim());
}

/**
 * Reporte de chequeo sin señal: muestra indicadores actuales y cuánto falta para disparar la entrada.
 */
async function sendNoSignalReport(symbol, price, analysis) {
  const safeSymbol = formatSymbol(symbol);
  const rsiTarget = config.indicators.rsiEntryThreshold;
  const rsiGap = (analysis.rsi - rsiTarget).toFixed(1);
  const emaGapPercent = ((price - analysis.ema) / analysis.ema * 100).toFixed(2);

  const rsiOk = analysis.rsi <= rsiTarget;
  const emaOk = price < analysis.ema;

  const rsiLine = rsiOk
    ? `✅ RSI: ${analysis.rsi} (retroceso OK)`
    : `❌ RSI: ${analysis.rsi} - faltan ${rsiGap} puntos para bajar a ${rsiTarget}`;

  const emaLine = emaOk
    ? `✅ Precio BAJO EMA: ${formatPrice(price)} < ${formatPrice(analysis.ema)} (-${Math.abs(emaGapPercent)}%)`
    : `❌ Precio SOBRE EMA: ${formatPrice(price)} > ${formatPrice(analysis.ema)} (+${emaGapPercent}%, necesita bajar ${formatUSD(Math.abs(price - analysis.ema))})`;

  const text = `
🔍 *CHEQUEO SIN SEÑAL - ${safeSymbol}*

${rsiLine}
${emaLine}

📊 Precio actual: *${formatPrice(price)}*
📊 EMA(${config.indicators.emaPeriod}): *${formatPrice(analysis.ema)}*
📈 RSI(${config.indicators.rsiPeriod}) anterior: *${analysis.previousRSI}*

⏳ Sin condiciones para abrir long.
  `.trim();

  await send(text);
}

/**
 * Mensaje de inicio del bot.
 */
async function sendStartup(tradingEnabled = false) {
  const modeLine = tradingEnabled
    ? '🟢 Modo: TRADING REAL ACTIVADO'
    : '🟡 Modo: Solo alertas (sin ordenes reales)';
  const symbolLine = '📌 Par: BTCUSD_PERP';
  const capitalLine = `💰 Capital: ${config.capitalBTC} BTC`;

  const text = `
🤖 *Crypto Bull Bot iniciado*

${symbolLine}
${modeLine}
${capitalLine}
📋 Estrategia: Long ${config.leverage}x con DCA
⏰ Chequeo: cada hora
📋 Resumen diario: 22:00
  `.trim();

  await send(text);
}

module.exports = { init, send, sendEntryAlert, sendDCAAlert, sendTPAlert, sendRiskAlert, sendDailySummary, sendNoSignalReport, sendStartup };
