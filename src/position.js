const fs = require('fs');
const path = require('path');
const config = require('../config');
const { localDateString, localISOString } = require('./utils');

const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');

/**
 * Carga el estado de posiciones desde disco.
 */
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { positions: {} };
  }
}

/**
 * Guarda el estado de posiciones en disco de forma asíncrona.
 */
async function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Obtiene la posición de un par, o crea una vacía.
 */
function getPosition(state, symbol) {
  if (!state.positions[symbol]) {
    state.positions[symbol] = createEmptyPosition(symbol);
  }
  return state.positions[symbol];
}

/**
 * Crea una posición vacía.
 */
function createEmptyPosition(symbol) {
  return {
    symbol,
    active: false,
    entries: [],          // [{ price, parts, contracts, date }]
    partsUsed: 0,
    contractsPerPart: 0,  // contratos por parte, calculado al abrir y congelado para todo el trade
    totalContracts: 0,    // contratos totales abiertos
    avgPrice: 0,
    totalInvested: 0,     // USD notional (totalContracts × $100)
    lastDCADate: null,
  };
}

function roundSafe(value) {
  return Number(Number(value).toFixed(8));
}

/**
 * Abre una posición long con la entrada inicial.
 * contractsPerPart se calcula fuera (en index.js al momento de abrir) y se pasa aquí para congelarlo.
 *
 * @param {object} state
 * @param {string} symbol
 * @param {number} price - Precio actual de entrada
 * @param {number} contractsPerPart - Contratos por parte (calculados según BTC price al abrir)
 * @param {number} parts - Partes a usar (default: initialParts del config)
 */
function openPosition(state, symbol, price, contractsPerPart, parts = config.initialParts, execution = {}) {
  const position = getPosition(state, symbol);
  if (position.active) return position;

  const contracts = Number.isFinite(execution.contracts) ? execution.contracts : parts * contractsPerPart;
  const appliedParts = Number.isFinite(execution.parts) ? execution.parts : parts;
  position.active = true;
  position.entries = [{ price, parts: roundSafe(appliedParts), contracts: roundSafe(contracts), date: localISOString() }];
  position.partsUsed = roundSafe(appliedParts);
  position.contractsPerPart = contractsPerPart;
  position.totalContracts = roundSafe(contracts);
  position.avgPrice = price;
  position.totalInvested = roundSafe(position.totalContracts * 100);
  position.lastDCADate = localDateString();

  saveState(state);
  return position;
}

/**
 * Agrega una entrada DCA a una posición activa.
 * Usa el contractsPerPart congelado en la posición al momento de la apertura.
 *
 * @param {object} state
 * @param {string} symbol
 * @param {number} price - Precio actual
 * @param {number} parts - Partes a agregar
 */
function addEntry(state, symbol, price, parts, execution = {}) {
  const position = getPosition(state, symbol);
  if (!position.active) return position;

  const contracts = Number.isFinite(execution.contracts) ? execution.contracts : parts * position.contractsPerPart;
  const appliedParts = Number.isFinite(execution.parts) ? execution.parts : parts;

  position.entries.push({
    price,
    parts: roundSafe(appliedParts),
    contracts: roundSafe(contracts),
    date: localISOString(),
  });
  position.partsUsed = roundSafe(position.partsUsed + appliedParts);
  position.totalContracts = roundSafe(position.totalContracts + contracts);
  position.totalInvested = roundSafe(position.totalContracts * 100);
  position.avgPrice = calcAvgPrice(position.entries);
  position.lastDCADate = localDateString();

  saveState(state);
  return position;
}

/**
 * Cierra una posición (TP alcanzado o cierre manual).
 */
function closePosition(state, symbol) {
  const position = getPosition(state, symbol);
  const closedPosition = { ...position };
  state.positions[symbol] = createEmptyPosition(symbol);
  saveState(state);
  return closedPosition;
}

/**
 * Reduce parcialmente una posición activa según contratos ejecutados en cierre.
 */
function reducePositionContracts(state, symbol, contractsToClose) {
  const position = getPosition(state, symbol);
  if (!position.active) return position;
  if (!Number.isFinite(contractsToClose) || contractsToClose <= 0) return position;

  const closeQty = Math.min(contractsToClose, position.totalContracts);
  const remaining = position.totalContracts - closeQty;

  if (remaining <= 0) {
    state.positions[symbol] = createEmptyPosition(symbol);
    saveState(state);
    return getPosition(state, symbol);
  }

  const ratio = remaining / position.totalContracts;
  position.entries = position.entries.map((e) => ({
    ...e,
    contracts: roundSafe(e.contracts * ratio),
    parts: roundSafe(e.parts * ratio),
  }));
  position.partsUsed = roundSafe(position.partsUsed * ratio);
  position.totalContracts = roundSafe(remaining);
  position.totalInvested = roundSafe(position.totalContracts * 100);
  position.avgPrice = calcAvgPrice(position.entries);

  saveState(state);
  return position;
}

/**
 * Calcula el precio promedio ponderado por contratos.
 * @param {Array} entries - [{ price, contracts }]
 */
function calcAvgPrice(entries) {
  let totalValue = 0;
  let totalContracts = 0;
  for (const entry of entries) {
    totalValue += entry.price * entry.contracts;
    totalContracts += entry.contracts;
  }
  return totalContracts > 0 ? totalValue / totalContracts : 0;
}

module.exports = {
  loadState,
  saveState,
  getPosition,
  openPosition,
  addEntry,
  closePosition,
  reducePositionContracts,
  calcAvgPrice,
};
