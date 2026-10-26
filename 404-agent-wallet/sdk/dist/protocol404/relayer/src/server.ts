import { createChain } from "./chain.js";
import { readConfig } from "./config.js";
import { createRelayerServer } from "./http.js";
import { RelayServicePool } from "./pool.js";
import { ConcurrencyGate, RelayService, ReservationBook } from "./service.js";
import { TradeIndexer } from "./trades.js";

const config = readConfig();
const chains = config.privateKeys.map(privateKey => createChain({ ...config, privateKey }));
await chains[0].verify();
const reservations = new ReservationBook();
const concurrency = new ConcurrencyGate(config.maxConcurrent);
const services = chains.map(chain => new RelayService({
  chainId: config.chainId, relayer: chain.relayer, contracts: config.contracts, fees: config.fees,
  feeMode: config.feeMode,
  gasCap: config.gasCap, maxConcurrent: config.maxConcurrent, reservationMs: config.reservationMs,
}, chain.adapter, reservations, concurrency));
const service = new RelayServicePool(services, config.contracts, new TradeIndexer(chains[0].tradeSource, config.marketBlock));
const server = createRelayerServer(service, config.bodyLimit, config.corsOrigin);
server.listen(config.port, config.host, () => process.stdout.write(`404 relayer listening on http://${config.host}:${config.port}\n`));

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
