import type { FastifyInstance } from "fastify";
import type { AgyAccountService } from "../../../packages/agy-accounts/src/service.js";
import { createBaseServer } from "./base-server.js";
import { registerAgyAccountRoutes } from "./agy-account-routes.js";

export interface AccountsServerOptions {
  port: number;
  humanOrigin: string;
  webRoot?: string;
  storageInstance?: string;
}

export function buildAccountsServer(
  accountService: AgyAccountService,
  options: AccountsServerOptions,
): FastifyInstance {
  const { app, humanCheck } = createBaseServer({
    port: options.port,
    humanOrigin: options.humanOrigin,
    mode: "accounts",
    features: {
      workflows: false,
      agy_accounts: true,
    },
    webRoot: options.webRoot,
    storageInstance: options.storageInstance,
  });

  registerAgyAccountRoutes(app, accountService, humanCheck);

  return app;
}
