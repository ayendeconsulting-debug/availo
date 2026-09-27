import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await NestFactory.create(AppModule.forRoot(config));
app.enableShutdownHooks();
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`Availo API listening on :${port} (${config.env})`);
