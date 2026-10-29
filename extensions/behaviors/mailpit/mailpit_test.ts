/**
 * Unit tests for the Mailpit behavior's exported helpers.
 *
 * These run offline — no Mailpit server required — and cover credential
 * encoding, URL joining, and response normalization.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { apiUrl, authHeader, mailpitJson, toMailbox } from "./mailpit.ts";

Deno.test("authHeader returns undefined without credentials", () => {
  assertEquals(authHeader(), undefined);
});

Deno.test("authHeader encodes basic auth", () => {
  assertEquals(authHeader("user", "pass"), `Basic ${btoa("user:pass")}`);
});

Deno.test("authHeader tolerates missing password", () => {
  assertEquals(authHeader("user"), `Basic ${btoa("user:")}`);
});

Deno.test("apiUrl strips trailing slashes", () => {
  assertEquals(
    apiUrl("http://localhost:8025/", "/api/v1/info"),
    "http://localhost:8025/api/v1/info",
  );
});

Deno.test("apiUrl keeps clean base URLs untouched", () => {
  assertEquals(
    apiUrl("http://localhost:8025", "/api/v1/info"),
    "http://localhost:8025/api/v1/info",
  );
});

Deno.test("toMailbox normalizes the Mailpit list shape", () => {
  const mailbox = toMailbox({
    messages_count: 2,
    messages_unread: 1,
    start: 0,
    messages: [
      {
        ID: "abc",
        MessageID: "<1@example.com>",
        Read: false,
        From: { Address: "no-reply@example.com" },
        To: [{ Address: "ci@example.com" }],
        Subject: "Build passed",
        Created: "2026-10-29T12:00:00Z",
        Tags: [],
        Size: 1200,
        Attachments: 0,
        Snippet: "All green",
      },
    ],
  });
  assertEquals(mailbox.total, 2);
  assertEquals(mailbox.unread, 1);
  assertEquals(mailbox.messages.length, 1);
  assertEquals(mailbox.messages[0].ID, "abc");
  assertEquals(mailbox.truncated, true); // 1 fetched of 2 total
});

Deno.test("toMailbox marks untruncated when everything fetched", () => {
  const mailbox = toMailbox({
    messages_count: 0,
    messages_unread: 0,
    start: 0,
    messages: [],
  });
  assertEquals(mailbox.truncated, false);
});

Deno.test("mailpitJson resolves JSON on success", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ Version: "v1.0" }), { status: 200 }),
    )) as typeof fetch;
  try {
    const res = await mailpitJson(
      {
        globalArgs: { url: "http://localhost:8025" },
        signal: new AbortController().signal,
      },
      "GET",
      "/api/v1/info",
    );
    assertEquals(res.Version, "v1.0");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("mailpitJson throws with status and body on error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("unauthorized", { status: 401 }),
    )) as typeof fetch;
  try {
    await assertRejects(
      () =>
        mailpitJson(
          {
            globalArgs: { url: "http://localhost:8025" },
            signal: new AbortController().signal,
          },
          "GET",
          "/api/v1/info",
        ),
      Error,
      "HTTP 401",
    );
  } finally {
    globalThis.fetch = original;
  }
});
