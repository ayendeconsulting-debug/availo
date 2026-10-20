import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { PaymentsService } from "./payments.service.js";

const SWEEP_EVERY_MS = 30_000;
const REFUND_EVERY_MS = 60_000;

/**
 * The payment jobs: close lapsed holds and submit queued refunds. Each is safe
 * to run concurrently on several API instances: holds are released by a guarded
 * UPDATE and refunds are claimed before they are submitted.
 *
 * pg-boss replaces these intervals when session warnings arrive (sprint 3), since
 * those need scheduled, delivery-tracked work.
 */
@Injectable()
export class PaymentJobs implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(PaymentJobs.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  onModuleInit() {
    if (!this.config.payments.runJobs) return;
    this.timers.push(setInterval(() => this.run("sweep", () => this.payments.sweepExpired()), SWEEP_EVERY_MS).unref());
    this.timers.push(setInterval(() => this.run("refunds", () => this.payments.submitRefunds()), REFUND_EVERY_MS).unref());
  }

  onApplicationShutdown() {
    for (const t of this.timers) clearInterval(t);
  }

  private running = new Set<string>();
  private async run(name: string, job: () => Promise<unknown>) {
    if (this.running.has(name)) return;
    this.running.add(name);
    try {
      await job();
    } catch (err) {
      this.log.error(`${name} job failed: ${(err as Error).message}`);
    } finally {
      this.running.delete(name);
    }
  }
}
