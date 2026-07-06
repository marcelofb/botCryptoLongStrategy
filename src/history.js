const fs = require('fs');
const path = require('path');
const { localISOString } = require('./utils');

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');

let writeLock = Promise.resolve();

/**
 * Lee el historial desde disco.
 * @returns {object} { ETHUSDT: [{ open, dcas, close }], ... }
 */
function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Guarda el historial en disco.
 * @param {object} history
 */
async function saveHistory(history) {
  const dir = path.dirname(HISTORY_FILE);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * Ejecuta una operación de escritura serializada (evita race conditions).
 * @param {function} fn - Recibe el historial y lo modifica
 */
async function withLock(fn) {
  writeLock = writeLock.then(async () => {
    const history = loadHistory();
    fn(history);
    await saveHistory(history);
  });
  await writeLock;
}

/**
 * Obtiene el ciclo abierto actual de un par, o null si no hay.
 */
function getOpenTrade(history, symbol) {
  const trades = history[symbol];
  if (!trades || trades.length === 0) return null;
  const last = trades[trades.length - 1];
  return last.close === null ? last : null;
}

/**
 * Registra apertura de posición.
 */
async function logOpen(symbol, price, parts) {
  await withLock((history) => {
    if (!history[symbol]) history[symbol] = [];
    history[symbol].push({
      open: { date: localISOString(), price, parts },
      dcas: [],
      close: null,
    });
  });
}

/**
 * Registra DCA.
 */
async function logDCA(symbol, price, parts, avgPriceBefore, avgPriceAfter, totalParts) {
  await withLock((history) => {
    const trade = getOpenTrade(history, symbol);
    if (!trade) return;
    trade.dcas.push({ date: localISOString(), price, parts, avgPriceBefore, avgPriceAfter, totalParts });
  });
}

/**
 * Registra cierre de posición con resultado.
 */
async function logClose(symbol, closePrice, position, pnlPercent, leveragedPnl) {
  await withLock((history) => {
    const trade = getOpenTrade(history, symbol);
    if (!trade) return;
    trade.close = {
      date: localISOString(),
      closePrice,
      avgPrice: position.avgPrice,
      totalParts: position.partsUsed,
      totalInvested: position.totalInvested,
      pnlPercent,
      leveragedPnl,
    };
  });
}

module.exports = { loadHistory, logOpen, logDCA, logClose };
