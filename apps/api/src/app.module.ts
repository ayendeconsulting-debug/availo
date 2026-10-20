import { type DynamicModule, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "./config.js";
import { CLOCK, type Clock, systemClock } from "./common/clock.js";
import { DbModule } from "./common/db.js";
import { DevSmsSender, SMS_SENDER, type SmsSender } from "./sms/sms.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { OtpService } from "./auth/otp.service.js";
import { TokensService } from "./auth/tokens.service.js";
import { RegistrationController } from "./registration/registration.controller.js";
import { ReservationsController } from "./reservations/reservations.controller.js";
import { PassService } from "./passes/pass.service.js";
import { PassesController } from "./passes/passes.controller.js";
import { GateController } from "./gate/gate.controller.js";
import { GateAuthService } from "./gate/gate-auth.service.js";
import { GateSyncService } from "./gate/gate-sync.service.js";
import { AttendantGuard } from "./gate/attendant.guard.js";
import { DriverController } from "./driver/driver.controller.js";
import { PAYMENT_PROVIDER, type PaymentProvider } from "./payments/provider.js";
import { PaystackProvider } from "./payments/paystack.js";
import { PaymentsService } from "./payments/payments.service.js";
import { ReceiptsService } from "./payments/receipts.service.js";
import { PaymentJobs } from "./payments/payment-jobs.js";
import { PaymentsController, WebhooksController } from "./payments/payments.controller.js";

export interface AppOverrides { clock?: Clock; sms?: SmsSender; payments?: PaymentProvider }

/**
 * Modular monolith (NFR-ARC-02). Module boundaries follow the requirements'
 * services so they can be split later; for sprint 1 they share one module.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [DbModule],
      global: true,
      controllers: [AuthController, RegistrationController, ReservationsController, PassesController, GateController, DriverController, PaymentsController, WebhooksController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: CLOCK, useValue: overrides.clock ?? systemClock },
        { provide: SMS_SENDER, useValue: overrides.sms ?? new DevSmsSender(config.env === "development") },
        { provide: PAYMENT_PROVIDER, useValue: overrides.payments ?? new PaystackProvider(config.payments.paystackSecretKey, config.payments.paystackBaseUrl) },
        OtpService,
        TokensService,
        AuthGuard,
        PassService,
        GateAuthService,
        GateSyncService,
        AttendantGuard,
        PaymentsService,
        ReceiptsService,
        PaymentJobs,
      ],
      exports: [APP_CONFIG, CLOCK],
    };
  }
}
