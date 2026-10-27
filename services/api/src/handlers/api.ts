import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { getApp } from "../config.js";
import { createRouter } from "../http.js";

let router: ReturnType<typeof createRouter> | undefined;

/** HTTP API (payload v2) entry point for the admin/REST API. */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const app = await getApp();
  router ??= createRouter({
    assistant: app.assistant,
    store: app.store,
    adminToken: app.config.adminToken,
    allowedOrigin: app.config.allowedOrigin,
  });
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return router({
    method: event.requestContext.http.method,
    path: event.rawPath,
    headers: event.headers ?? {},
    body,
  });
}
