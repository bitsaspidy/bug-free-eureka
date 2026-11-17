import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

/**
 * Minimal structural views of Express 4/5 request and response objects.
 * Defined here so the published types don't require `@types/express`.
 */
export interface BfeRequest extends IncomingMessage {
  ip?: string | undefined;
  headers: IncomingHttpHeaders;
  method?: string | undefined;
  baseUrl?: string;
  route?: { path?: unknown } | undefined;
  body?: unknown;
  query?: unknown;
  app?: { get(name: string): unknown };
}

export interface BfeResponse extends ServerResponse {
  locals?: Record<string, unknown>;
}

export type BfeNext = (err?: unknown) => void;

export type BfeMiddleware = (req: BfeRequest, res: BfeResponse, next: BfeNext) => void;

/** Diagnostic events from the middleware. Never contain keys, IPs or secrets. */
export interface BfeLogEvent {
  type: "store_error" | "trust_proxy_true";
  message: string;
  /** Events suppressed since the previous one of this type. */
  suppressed?: number;
}

export type BfeLogger = (event: BfeLogEvent) => void;
