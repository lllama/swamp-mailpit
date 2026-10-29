/**
 * Mailpit behavior type for swamp — wraps the Mailpit v1 HTTP API.
 *
 * Mailpit (https://mailpit.axllent.org) is a self-hosted email testing tool:
 * an SMTP catch-all with a REST API. This behavior exposes that API as typed
 * methods so swamp workflows can send test mail, assert messages arrived,
 * inspect contents, and clean the mailbox between runs — all through
 * `swamp behavior run` and CEL expressions over the resulting data.
 *
 * Credentials are optional (Mailpit's Basic Authentication). Supply them as
 * definition global arguments, ideally via a vault expression such as
 * `${{ vault.get("default", "mailpit-password") }}` — never hardcode them.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Default Mailpit UI/API base URL when the definition supplies none. */
const DEFAULT_URL = "http://localhost:8025";

/** An RFC 5322 email address as returned by Mailpit (`Name` is optional). */
const AddressSchema = z.object({
  /** Display name, when the address carries one. */
  Name: z.string().optional(),
  /** The bare email address, e.g. `jane@example.com`. */
  Address: z.string(),
});

/** Summary of one stored message, as listed by `list` and `search`. */
const MessageSummarySchema = z
  .object({
    /** Mailpit database ID — the value every other method addresses. */
    ID: z.string(),
    /** The message's `Message-ID` header value. */
    MessageID: z.string(),
    /** Whether the message has been marked as read. */
    Read: z.boolean(),
    /** Sender address. */
    From: AddressSchema,
    /** Primary recipients. */
    To: z.array(AddressSchema),
    /** Carbon-copy recipients, when present. */
    Cc: z.array(AddressSchema).optional(),
    /** Blind carbon-copy recipients, when present. */
    Bcc: z.array(AddressSchema).optional(),
    /** Subject line, possibly empty. */
    Subject: z.string(),
    /** When Mailpit accepted the message (extended RFC 3339). */
    Created: z.string(),
    /** Mailpit tags applied to the message. */
    Tags: z.array(z.string()),
    /** Total message size in bytes. */
    Size: z.number(),
    /** Number of attachments (0 when none). */
    Attachments: z.number(),
    /** Up-to-250-character plain-text preview. */
    Snippet: z.string(),
    /** SMTP/Send-API username that accepted the message, when any. */
    Username: z.string().optional(),
  });

/** Full single message body as returned by `get`. */
const MessageSchema = MessageSummarySchema.extend({
  /** Decoded plain-text body, when the message has one. */
  Text: z.string().optional(),
  /** HTML body, when the message has one (can be large). */
  HTML: z.string().optional(),
  /** Attachment metadata (content is fetched separately, not stored). */
  Attachments: z
    .array(
      z.object({
        /** Attachment part ID for the part endpoint. */
        PartID: z.string(),
        /** Original filename. */
        FileName: z.string(),
        /** Detected MIME type. */
        ContentType: z.string(),
        /** Inline content ID (`cid:`), when present. */
        ContentID: z.string().optional(),
        /** Size in bytes. */
        Size: z.number(),
      }),
    )
    .optional(),
});

/** Mailbox snapshot written by `list` and `search`. */
const MailboxSchema = z.object({
  /** Total messages matching the query. */
  total: z.number(),
  /** Unread messages matching the query. */
  unread: z.number(),
  /** Pagination offset the page started at. */
  start: z.number(),
  /** Message summaries, newest first. */
  messages: z.array(MessageSummarySchema),
  /** True when more results exist than the limit fetched. */
  truncated: z.boolean(),
});

/** Server counters from Mailpit's `/api/v1/info`, written by `stats`. */
const ServerStatsSchema = z.object({
  /** Running Mailpit version. */
  version: z.string(),
  /** Newest released Mailpit version, when reported. */
  latestVersion: z.string().optional(),
  /** Total messages currently stored. */
  messages: z.number(),
  /** Total unread messages currently stored. */
  unread: z.number(),
  /** SQLite database size in bytes. */
  databaseSize: z.number(),
  /** Server uptime in seconds. */
  uptimeSeconds: z.number(),
});

/** Result of a `send` call — echoes the message Mailpit created. */
const SentSchema = z.object({
  /** Mailpit database ID of the newly created message. */
  id: z.string(),
  /** Recipients the message was addressed to. */
  to: z.array(z.string()),
  /** Subject line that was set. */
  subject: z.string(),
});

/** Result of a mutation (`markRead`, `delete`) — what the API acknowledged. */
const MutationResultSchema = z.object({
  /** Human-readable acknowledgment from Mailpit (usually "ok"). */
  status: z.string(),
  /** Number of message IDs the request named, if any. */
  affected: z.number().optional(),
});

/** Global arguments every method shares; set once on the definition. */
const GlobalArgsSchema = z.object({
  /** Base URL of the Mailpit server, e.g. `http://localhost:8025`. */
  url: z.string().url().default(DEFAULT_URL),
  /** Basic Auth username, when Mailpit requires authentication. */
  username: z.string().optional(),
  /** Basic Auth password; supply via a vault expression, never in cleartext. */
  password: z.string().optional().meta({ sensitive: true }),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type MessageSummary = z.infer<typeof MessageSummarySchema>;

/**
 * Build an Authorization header value, or undefined when unauthenticated.
 *
 * @param username Basic Auth username, when configured.
 * @param password Basic Auth password, when configured.
 * @returns A `Basic …` header value, or undefined when no credentials exist.
 */
export function authHeader(
  username?: string,
  password?: string,
): string | undefined {
  if (username === undefined && password === undefined) return undefined;
  const raw = `${username ?? ""}:${password ?? ""}`;
  const b64 = btoa(raw);
  return `Basic ${b64}`;
}

/**
 * Join the configured base URL with a Mailpit v1 API path.
 *
 * Trailing slashes on the configured URL are tolerated so definitions can
 * store either `http://host:8025` or `http://host:8025/`.
 *
 * @param url Base URL of the Mailpit server.
 * @param path API path beginning with `/api/v1`.
 * @returns Absolute URL for the request.
 */
export function apiUrl(url: string, path: string): string {
  return `${url.replace(/\/+$/, "")}${path}`;
}

/** Context fields the methods rely on; typed inline per the typing guide. */
interface MethodContext {
  /** Validated global arguments from the definition. */
  globalArgs: GlobalArgs;
  /** Cancellation signal for in-flight requests. */
  signal: AbortSignal;
  /** Structured logger scoped to this method. */
  logger: {
    /** Log at info level. */
    info: (msg: string, props?: unknown) => void;
    /** Log at warning level. */
    warning: (msg: string, props?: unknown) => void;
    /** Log at error level. */
    error: (msg: string, props?: unknown) => void;
  };
  /** Write a structured resource and return its handle. */
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Fields `mailpitJson` needs; methods pass their whole context. */
interface RequestCtx {
  /** Validated global arguments from the definition. */
  globalArgs: Pick<GlobalArgs, "url" | "username" | "password">;
  /** Cancellation signal for the request. */
  signal: AbortSignal;
}

/**
 * Perform a JSON request against the configured Mailpit server.
 *
 * Throws on transport failure or any non-2xx response, quoting the response
 * body so misconfiguration (wrong URL, missing auth) is visible in run logs.
 * Exported for unit tests; not used by callers of this module.
 *
 * @param ctx Method context carrying global arguments and the signal.
 * @param method HTTP method to issue.
 * @param path API path beginning with `/api/v1`.
 * @param body Optional JSON request body.
 * @returns The parsed JSON response.
 */
export async function mailpitJson(
  ctx: RequestCtx,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const auth = authHeader(ctx.globalArgs.username, ctx.globalArgs.password);
  const res = await fetch(apiUrl(ctx.globalArgs.url, path), {
    method,
    headers: {
      ...(auth ? { Authorization: auth } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: ctx.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Mailpit ${method} ${path} failed: HTTP ${res.status}${
        text ? ` — ${text}` : ""
      }`,
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Shape Mailpit returns from `/api/v1/info`. */
interface MailpitInfoResponse {
  /** Running version. */
  Version: string;
  /** Newest released version, when known. */
  LatestVersion?: string;
  /** Total stored messages. */
  Messages: number;
  /** Total unread messages. */
  Unread: number;
  /** Database size in bytes. */
  DatabaseSize: number;
  /** Runtime counters. */
  RuntimeStats?: { /** Uptime in seconds. */ Uptime: number };
}

/** Shape Mailpit returns from the Send API. */
interface MailpitSendResponse {
  /** Database ID of the created message. */
  ID: string;
}

/** Shape Mailpit returns from list/search endpoints. */
interface MailpitMessagesResponse {
  /** Total messages matching the query. */
  messages_count: number;
  /** Unread messages matching the query. */
  messages_unread: number;
  /** Pagination offset. */
  start: number;
  /** Message summaries, newest first. */
  messages: unknown[];
}

/**
 * Normalize a Mailpit list/search response into the mailbox resource shape.
 *
 * Exported for unit tests; not used by callers of this module.
 *
 * @param res Raw JSON parsed from `/api/v1/messages` or `/api/v1/search`.
 * @returns Mailbox resource data ready for `writeResource`.
 */
export function toMailbox(
  res: MailpitMessagesResponse,
): z.infer<typeof MailboxSchema> {
  const messages = res.messages as MessageSummary[];
  return {
    total: res.messages_count,
    unread: res.messages_unread,
    start: res.start,
    messages,
    truncated: res.start + messages.length < res.messages_count,
  };
}

/** Arguments for `list`. */
const ListArgsSchema = z.object({
  /** Maximum number of summaries to fetch (Mailpit default 50). */
  limit: z.number().int().positive().max(1000).default(50),
  /** Pagination offset into the newest-first list. */
  start: z.number().int().nonnegative().default(0),
});

/** Arguments for `search`. */
const SearchArgsSchema = z.object({
  /** Mailpit search expression, e.g. `from:no-reply@example.com`. */
  query: z.string().min(1),
  /** Maximum number of summaries to fetch (Mailpit default 50). */
  limit: z.number().int().positive().max(1000).default(50),
  /** Pagination offset into the newest-first results. */
  start: z.number().int().nonnegative().default(0),
});

/** Arguments for `get`. */
const GetArgsSchema = z.object({
  /** Message database ID, or the literal `latest`. */
  id: z.string().min(1),
});

/** Arguments for `send`. */
const SendArgsSchema = z.object({
  /** Sender email address. */
  from: z.string().email(),
  /** Recipient email addresses. */
  to: z.array(z.string().email()).min(1),
  /** Subject line. */
  subject: z.string().default(""),
  /** Plain-text body. */
  text: z.string().optional(),
  /** HTML body. */
  html: z.string().optional(),
  /** Extra headers as key/value pairs. */
  headers: z.record(z.string(), z.string()).optional(),
});

/** Arguments for `markRead`. */
const MarkReadArgsSchema = z.object({
  /** Message IDs to update; omit with `search` or for the whole mailbox. */
  ids: z.array(z.string()).optional(),
  /** Search expression to update in bulk, e.g. `tag:nightly`. */
  search: z.string().optional(),
  /** Status to set: true marks read, false marks unread. */
  read: z.boolean().default(true),
});

/** Arguments for `delete`. */
const DeleteArgsSchema = z.object({
  /** Message IDs to delete. */
  ids: z.array(z.string()).optional(),
  /** Explicit opt-in required to delete every message (Mailpit deletes all when no IDs are sent). */
  all: z.boolean().default(false),
});

/**
 * Mailpit behavior type for swamp.
 *
 * Read methods (`stats`, `list`, `search`, `get`) publish resources that
 * workflows and other behaviors can reference via CEL, e.g.
 * `data.latest("ci-mail", "messages-search").attributes.total == 0`.
 * Mutation methods (`send`, `markRead`, `delete`) acknowledge what changed.
 */
export const behavior = {
  /** Registry type name; installed as `@lllama/mailpit`. */
  type: "@lllama/mailpit",
  /** CalVer version of this behavior type definition. */
  version: "2026.10.29.2",
  /** Lazy upgrades for instances created on earlier versions. */
  upgrades: [
    {
      /** Target version of this upgrade step. */
      toVersion: "2026.10.29.2",
      /** Metadata-only release; global arguments unchanged. */
      description: "Add repository metadata, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  /** Arguments set once per definition instance. */
  globalArguments: GlobalArgsSchema,
  /** Data outputs the methods publish. */
  resources: {
    messages: {
      description: "Mailbox snapshot: counts plus message summaries",
      schema: MailboxSchema,
      lifetime: "1d",
      garbageCollection: 5,
    },
    message: {
      description: "One full message including text/HTML body",
      schema: MessageSchema,
      lifetime: "1d",
      garbageCollection: 5,
    },
    server: {
      description: "Server counters from /api/v1/info",
      schema: ServerStatsSchema,
      lifetime: "1d",
      garbageCollection: 5,
    },
    sent: {
      description: "Acknowledgment from the Send API",
      schema: SentSchema,
      lifetime: "1d",
      garbageCollection: 5,
    },
    mutation: {
      description: "Acknowledgment from markRead/delete",
      schema: MutationResultSchema,
      lifetime: "1d",
      garbageCollection: 5,
    },
  },
  /** Pre-flight checks run before mutating methods. */
  checks: {
    "server-reachable": {
      description: "Mailpit server answers /api/v1/info",
      labels: ["live"],
      execute: async (
        ctx: {
          globalArgs: GlobalArgs;
          signal: AbortSignal;
          logger: { info: (msg: string, props?: unknown) => void };
        },
      ) => {
        try {
          const auth = authHeader(
            ctx.globalArgs.username,
            ctx.globalArgs.password,
          );
          const res = await fetch(apiUrl(ctx.globalArgs.url, "/api/v1/info"), {
            headers: auth ? { Authorization: auth } : {},
            signal: ctx.signal,
          });
          if (!res.ok) {
            return {
              pass: false,
              errors: [
                `Mailpit responded HTTP ${res.status} at ${ctx.globalArgs.url}`,
              ],
            };
          }
          return { pass: true };
        } catch (e) {
          return {
            pass: false,
            errors: [
              `Cannot reach Mailpit at ${ctx.globalArgs.url}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ],
          };
        }
      },
    },
  },
  /** Methods exposing the Mailpit v1 API. */
  methods: {
    stats: {
      description:
        "Fetch server counters (messages, unread, version, uptime) into the server resource",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: MethodContext) => {
        ctx.logger.info("Fetching Mailpit server stats from {url}", {
          url: ctx.globalArgs.url,
        });
        const info = (await mailpitJson(
          ctx,
          "GET",
          "/api/v1/info",
        )) as unknown as MailpitInfoResponse;
        const handle = await ctx.writeResource("server", "server-info", {
          version: info.Version,
          ...(info.LatestVersion !== undefined
            ? { latestVersion: info.LatestVersion }
            : {}),
          messages: info.Messages,
          unread: info.Unread,
          databaseSize: info.DatabaseSize,
          uptimeSeconds: info.RuntimeStats?.Uptime ?? 0,
        });
        ctx.logger.info(
          "Stored server stats: {messages} messages, {unread} unread, version {version}",
          {
            messages: info.Messages,
            unread: info.Unread,
            version: info.Version,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    list: {
      description:
        "List stored messages newest-first into the messages resource",
      arguments: ListArgsSchema,
      execute: async (
        args: z.infer<typeof ListArgsSchema>,
        ctx: MethodContext,
      ) => {
        ctx.logger.info("Listing Mailpit messages (limit {limit})", {
          limit: args.limit,
        });
        const res = (await mailpitJson(
          ctx,
          "GET",
          `/api/v1/messages?limit=${args.limit}&start=${args.start}`,
        )) as unknown as MailpitMessagesResponse;
        const handle = await ctx.writeResource(
          "messages",
          "messages-list",
          toMailbox(res),
        );
        ctx.logger.info("Stored mailbox snapshot: {total} messages", {
          total: res.messages_count,
        });
        return { dataHandles: [handle] };
      },
    },
    search: {
      description:
        "Run a Mailpit search query (e.g. `to:ci@example.com`, `tag:nightly`) into the messages resource",
      arguments: SearchArgsSchema,
      execute: async (
        args: z.infer<typeof SearchArgsSchema>,
        ctx: MethodContext,
      ) => {
        ctx.logger.info("Searching Mailpit for {query}", { query: args.query });
        const res = (await mailpitJson(
          ctx,
          "GET",
          `/api/v1/search?query=${
            encodeURIComponent(args.query)
          }&limit=${args.limit}&start=${args.start}`,
        )) as unknown as MailpitMessagesResponse;
        const handle = await ctx.writeResource(
          "messages",
          "messages-search",
          toMailbox(res),
        );
        ctx.logger.info("Stored search snapshot: {total} matches", {
          total: res.messages_count,
        });
        return { dataHandles: [handle] };
      },
    },
    get: {
      description:
        "Fetch one full message (by ID or `latest`) into the message resource; marks it read",
      arguments: GetArgsSchema,
      execute: async (
        args: z.infer<typeof GetArgsSchema>,
        ctx: MethodContext,
      ) => {
        ctx.logger.info("Fetching Mailpit message {id}", { id: args.id });
        const msg = await mailpitJson(
          ctx,
          "GET",
          `/api/v1/message/${encodeURIComponent(args.id)}`,
        );
        const handle = await ctx.writeResource(
          "message",
          `message-${args.id}`,
          msg,
        );
        ctx.logger.info("Stored full message {id}", { id: args.id });
        return { dataHandles: [handle] };
      },
    },
    send: {
      description:
        "Send a message through the Mailpit Send API (great for send-then-assert workflows)",
      arguments: SendArgsSchema,
      execute: async (
        args: z.infer<typeof SendArgsSchema>,
        ctx: MethodContext,
      ) => {
        ctx.logger.info("Sending message via Mailpit Send API to {to}", {
          to: args.to.join(", "),
        });
        const body: Record<string, unknown> = {
          From: { Email: args.from },
          To: args.to.map((email) => ({ Email: email })),
          Subject: args.subject,
        };
        if (args.text !== undefined) body.Text = args.text;
        if (args.html !== undefined) body.HTML = args.html;
        if (args.headers !== undefined) body.Headers = args.headers;
        const res = (await mailpitJson(
          ctx,
          "POST",
          "/api/v1/send",
          body,
        )) as unknown as MailpitSendResponse;
        const handle = await ctx.writeResource("sent", `sent-${res.ID}`, {
          id: res.ID,
          to: args.to,
          subject: args.subject,
        });
        ctx.logger.info("Sent message, Mailpit ID {id}", { id: res.ID });
        return { dataHandles: [handle] };
      },
    },
    markRead: {
      description:
        "Set the read status of specific messages, of everything matching a search, or of the whole mailbox",
      arguments: MarkReadArgsSchema,
      execute: async (
        args: z.infer<typeof MarkReadArgsSchema>,
        ctx: MethodContext,
      ) => {
        ctx.logger.info("Setting read status {read} via Mailpit API", {
          read: args.read,
        });
        const body: Record<string, unknown> = { Read: args.read };
        if (args.ids !== undefined) body.IDs = args.ids;
        if (args.search !== undefined) body.Search = args.search;
        await mailpitJson(ctx, "PUT", "/api/v1/messages", body);
        const handle = await ctx.writeResource("mutation", "mutation-read", {
          status: "ok",
          ...(args.ids !== undefined ? { affected: args.ids.length } : {}),
        });
        ctx.logger.info("Read status updated", {});
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description:
        "Delete specific messages by ID; set all=true to purge the entire mailbox",
      arguments: DeleteArgsSchema,
      execute: async (
        args: z.infer<typeof DeleteArgsSchema>,
        ctx: MethodContext,
      ) => {
        if (args.ids === undefined && !args.all) {
          throw new Error(
            "Refusing to delete the whole mailbox: pass ids=[...] or all=true",
          );
        }
        ctx.logger.info(
          "Deleting Mailpit messages ({scope})",
          { scope: args.ids !== undefined ? `${args.ids.length} ids` : "all" },
        );
        const body = args.ids !== undefined ? { IDs: args.ids } : {};
        await mailpitJson(ctx, "DELETE", "/api/v1/messages", body);
        const handle = await ctx.writeResource("mutation", "mutation-delete", {
          status: "ok",
          ...(args.ids !== undefined ? { affected: args.ids.length } : {}),
        });
        ctx.logger.info("Deleted Mailpit messages", {});
        return { dataHandles: [handle] };
      },
    },
  },
};
