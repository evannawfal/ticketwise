import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { Writable } from "node:stream";
import { getApp } from "../config.js";
import { createStreamHandler } from "../http.js";

/**
 * Streaming answers on AWS. API Gateway's HTTP API buffers whole responses, so
 * /ask/stream and /draft/stream are served from a Lambda function URL in
 * RESPONSE_STREAM mode instead. `awslambda` is a global the Node.js runtime
 * provides; it doesn't exist outside Lambda.
 */
declare const awslambda: {
  streamifyResponse(
    fn: (event: APIGatewayProxyEventV2, responseStream: Writable, context: unknown) => Promise<void>,
  ): unknown;
  HttpResponseStream: {
    from(stream: Writable, meta: { statusCode: number; headers: Record<string, string> }): Writable;
  };
};

let open: ReturnType<typeof createStreamHandler> | undefined;

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const app = await getApp();
  open ??= createStreamHandler({
    assistant: app.assistant,
    adminToken: app.config.adminToken,
    allowedOrigin: app.config.allowedOrigin,
  });
  const ac = new AbortController();
  responseStream.on("close", () => ac.abort(new Error("client disconnected")));
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  const res = await open(
    { method: event.requestContext.http.method, path: event.rawPath, headers: event.headers ?? {}, body },
    ac.signal,
  );
  const out = awslambda.HttpResponseStream.from(responseStream, { statusCode: res.statusCode, headers: res.headers });
  if (typeof res.body === "string") {
    out.write(res.body);
  } else {
    for await (const chunk of res.body) {
      if (ac.signal.aborted) break;
      out.write(chunk);
    }
  }
  out.end();
});
