import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const boot = Date.now();
const clock = config.clockStart ? { now: () => new Date(config.clockStart!.getTime() + (Date.now() - boot)) } : undefined;
const app = await NestFactory.create(AppModule.forRoot(config, clock ? { clock } : {}));
app.enableShutdownHooks();
app.enableCors({ origin: config.corsOrigins, allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Gate-Device"], maxAge: 600 });
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`Availo API listening on :${port} (${config.env}${config.clockStart ? `, clock from ${config.clockStart.toISOString()}` : ""})`);
