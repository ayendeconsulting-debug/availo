import { Global, Module, type OnApplicationShutdown, Inject } from "@nestjs/common";
import pg from "pg";
import { createPgReservationStore } from "@availo/db";
import { APP_CONFIG, type AppConfig } from "../config.js";

export const PG_POOL = Symbol("PG_POOL");
export const RESERVATION_STORE = Symbol("RESERVATION_STORE");

class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}
  async onApplicationShutdown() { await this.pool.end(); }
}

@Global()
@Module({
  providers: [
    { provide: PG_POOL, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new pg.Pool({ connectionString: c.databaseUrl, max: 20 }) },
    { provide: RESERVATION_STORE, inject: [PG_POOL], useFactory: (p: pg.Pool) => createPgReservationStore(p) },
    PoolCloser,
  ],
  exports: [PG_POOL, RESERVATION_STORE],
})
export class DbModule {}
