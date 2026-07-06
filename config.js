module.exports = {
  // Par a monitorear (Binance coin-margined futures DAPI)
  pairs: ['BTCUSD_PERP'],

  // Leverage de la estrategia
  leverage: 5,

  // Capital total por par en BTC
  // El bot calcula contratos/parte al abrir cada posición según el precio vigente
  capitalPerPairBTC: 0.1,

  // Número de partes en que se divide el capital
  totalParts: 60,

  // Partes para la entrada inicial
  initialParts: 3,

  // Reglas de DCA: % de pérdida en cuenta (considerando 5x leverage)
  dcaRules: [
    { maxLoss: -5,        parts: 3 },  // hasta -5% cuenta  → 3 partes
    { maxLoss: -10,       parts: 4 },  // hasta -10% cuenta → 4 partes
    { maxLoss: -15,       parts: 5 },  // hasta -15% cuenta → 5 partes
    { maxLoss: -Infinity, parts: 6 },  // más de -15% cuenta → 6 partes
  ],

  // Máximo de recargas DCA por día por par
  maxDCAPerDay: 1,

  // RSI máximo en 1h para considerar que es un buen momento de recarga DCA
  // Para long: queremos precio bajando (RSI bajo ≤ 50), no con impulso alcista
  dcaOptimal1hRSI: 50,

  // Hora límite local (0-23): si no se ejecutó DCA aún, se ignora el filtro RSI 1h y se ejecuta igual
  // 21 = 21:00 hora local (Argentina), 1h antes del resumen diario a las 22:00
  dcaFallbackHour: 21,

  // Take Profit: cerrar al +15% de ganancia en cuenta (= 3% subida de precio a 5x leverage)
  takeProfitPercent: 3,

  // Umbral de alerta de riesgo: distancia a liquidación estimada
  liquidationAlertPercent: 5,

  // Indicadores técnicos
  indicators: {
    rsiPeriod: 14,
    rsiEntryThreshold: 60,  // RSI ≤ 60 = señal de entrada para long (pullback en uptrend)
    emaPeriod: 20,
    timeframe: '4h',
    klinesLimit: 100,
  },

  // Frecuencia de chequeo en formato cron (cada 1 hora)
  checkCron: '0 */1 * * *',

  // Resumen diario a las 22:00
  dailySummaryCron: '0 22 * * *',
};
