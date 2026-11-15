import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findServer, quickConnectStart, refresh, signInWithPassword, signInWithQuickConnect, versionAtLeast, type Session } from "./auth";
import { ApiError, authHeader, forgetConfirmedServer, readCapped, request } from "./client";

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const SERVER = { url: "http://192.168.86.20:8096", id: SERVER_ID, name: "Home", version: "10.10.7" };
const CONNECTION = { server: SERVER.url, deviceId: "abc123", token: "tok" };

type Reply = { status?: number; json?: unknown; text?: string } | Error;

/// Replaces fetch with canned replies keyed by "METHOD url"; anything else is unreachable.
function serve(replies: Record<string, Reply>) {
  const calls: { key: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url}`;
    calls.push({ key, init });
    const reply = replies[key];
    if (!reply || reply instanceof Error) throw reply ?? new TypeError("Failed to fetch");
    const body = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    return new Response(reply.status === 204 ? null : body, { status: reply.status ?? 200 });
  });
  return calls;
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  forgetConfirmedServer();
});

describe("authHeader", () => {
  it("names the client and only adds a token when there is one", () => {
    expect(authHeader("abc123")).toBe('MediaBrowser Client="Wavetile TV", Device="LG TV", DeviceId="abc123", Version="0.1.0"');
    expect(authHeader("abc123", "tok")).toContain(', Token="tok"');
  });
});

describe("request", () => {
  it("sends the auth header and JSON body, and parses the reply", async () => {
    const calls = serve({ "POST http://192.168.86.20:8096/Thing": { json: { ok: true } } });
    await expect(request(CONNECTION, "/Thing", { method: "POST", body: { a: 1 } })).resolves.toEqual({ ok: true });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toContain('Token="tok"');
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.init.body).toBe('{"a":1}');
  });

  it("reports HTTP errors with the status and without the token, query or host", async () => {
    serve({ "GET http://192.168.86.20:8096/Users/Me?secret=s3cret": { status: 401 } });
    const error = await request(CONNECTION, "/Users/Me", { query: { secret: "s3cret" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe("GET /Users/Me: HTTP 401");
  });

  it("reports an unreachable server and a non-JSON reply as status 0", async () => {
    serve({ "GET http://192.168.86.20:8096/Page": { text: "<html>router</html>" } });
    await expect(request(CONNECTION, "/Nope")).rejects.toMatchObject({ status: 0 });
    await expect(request(CONNECTION, "/Page")).rejects.toMatchObject({ status: 0 });
  });

  it("returns undefined for an empty reply", async () => {
    serve({ "POST http://192.168.86.20:8096/Sessions/Logout": { status: 204 } });
    await expect(request(CONNECTION, "/Sessions/Logout", { method: "POST" })).resolves.toBeUndefined();
  });
});

describe("findServer", () => {
  const info = { Id: SERVER_ID, Version: "10.10.7", ServerName: "Home" };

  it("picks the first address that answers like Jellyfin", async () => {
    serve({ "GET http://192.168.86.20:8096/System/Info/Public": { json: info } });
    await expect(findServer("192.168.86.20")).resolves.toEqual(SERVER);
  });

  it("prefers the likelier address when several answer", async () => {
    serve({
      "GET http://192.168.86.20:8096/System/Info/Public": { json: info },
      "GET http://192.168.86.20/System/Info/Public": { json: { ...info, ServerName: "Other" } },
    });
    expect((await findServer("192.168.86.20")).url).toBe("http://192.168.86.20:8096");
  });

  it("rejects something that answers but isn't Jellyfin", async () => {
    serve({ "GET http://nas:8096/System/Info/Public": { json: { hello: "world" } } });
    await expect(findServer("nas")).rejects.toMatchObject({ status: 0 });
  });

  it("rejects a server Id that isn't hex", async () => {
    serve({ "GET http://nas:8096/System/Info/Public": { json: { ...info, Id: "../x" } } });
    await expect(findServer("nas")).rejects.toMatchObject({ status: 0 });
  });

  it("cuts an oversized server name", async () => {
    serve({ "GET https://example.com/System/Info/Public": { json: { ...info, ServerName: "x".repeat(500) } } });
    expect((await findServer("example.com")).name).toHaveLength(80);
  });
});

describe("quick connect", () => {
  it("falls back to GET on servers that refuse POST", async () => {
    const calls = serve({
      "POST http://192.168.86.20:8096/QuickConnect/Initiate": { status: 405 },
      "GET http://192.168.86.20:8096/QuickConnect/Initiate": { json: { Secret: "s", Code: "123456" } },
    });
    await expect(quickConnectStart(SERVER.url)).resolves.toEqual({ secret: "s", code: "123456" });
    expect(calls).toHaveLength(2);
  });

  it("rejects a code that isn't letters and digits", async () => {
    serve({ "POST http://192.168.86.20:8096/QuickConnect/Initiate": { json: { Secret: "s", Code: "<b>1</b>" } } });
    await expect(quickConnectStart(SERVER.url)).rejects.toBeInstanceOf(ApiError);
  });

  it("builds a session from the server's reply", async () => {
    serve({
      "POST http://192.168.86.20:8096/Users/AuthenticateWithQuickConnect": {
        json: { AccessToken: "0123abcd", User: { Id: "9f8e7d6c-0000-0000-0000-000000000000", Name: "  Derrell " } },
      },
    });
    await expect(signInWithQuickConnect(SERVER, "s")).resolves.toEqual({
      server: SERVER.url,
      serverId: SERVER_ID,
      serverName: "Home",
      serverVersion: "10.10.7",
      userId: "9f8e7d6c-0000-0000-0000-000000000000",
      userName: "Derrell",
      token: "0123abcd",
    });
  });
});

describe("password sign-in", () => {
  it("passes a wrong password through as 401", async () => {
    serve({ "POST http://192.168.86.20:8096/Users/AuthenticateByName": { status: 401 } });
    await expect(signInWithPassword(SERVER, "me", "wrong")).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a token that could break out of the header", async () => {
    serve({
      "POST http://192.168.86.20:8096/Users/AuthenticateByName": { json: { AccessToken: 'a", Evil="1', User: { Id: "abc" } } },
    });
    await expect(signInWithPassword(SERVER, "me", "pw")).rejects.toMatchObject({ status: 0 });
  });
});

describe("server check", () => {
  const PUBLIC = "GET http://192.168.86.20:8096/System/Info/Public";
  const info = { Id: SERVER_ID, Version: "10.10.7", ServerName: "Home" };
  const checked = { ...CONNECTION, serverId: SERVER_ID };

  it("sends the token only after the address answers with the saved server Id", async () => {
    const calls = serve({ [PUBLIC]: { json: info }, "GET http://192.168.86.20:8096/Thing": { json: 1 } });
    await expect(request(checked, "/Thing")).resolves.toBe(1);
    expect(calls.map((call) => call.key)).toEqual([PUBLIC, "GET http://192.168.86.20:8096/Thing"]);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).not.toContain("Token=");
  });

  it("never sends the token to a different server at the same address", async () => {
    const calls = serve({ [PUBLIC]: { json: { ...info, Id: "ffffffffffffffffffffffffffffffff" } }, "GET http://192.168.86.20:8096/Thing": { json: 1 } });
    await expect(request(checked, "/Thing")).rejects.toMatchObject({ status: 0 });
    expect(calls.map((call) => call.key)).toEqual([PUBLIC]);
  });

  it("never sends the token when the check can't be answered", async () => {
    const calls = serve({ "GET http://192.168.86.20:8096/Thing": { json: 1 } });
    await expect(request(checked, "/Thing")).rejects.toMatchObject({ status: 0 });
    expect(calls.every((call) => !(call.init.headers as Record<string, string>).Authorization?.includes("Token="))).toBe(true);
  });

  it("checks once for a burst of requests, and again after a failure", async () => {
    const calls = serve({ [PUBLIC]: { json: info }, "GET http://192.168.86.20:8096/Thing": { json: 1 } });
    await Promise.all([request(checked, "/Thing"), request(checked, "/Thing"), request(checked, "/Thing")]);
    expect(calls.filter((call) => call.key === PUBLIC)).toHaveLength(1);
    await request(checked, "/Gone").catch(() => undefined); // unreachable: forgets the check
    await request(checked, "/Thing");
    expect(calls.filter((call) => call.key === PUBLIC)).toHaveLength(2);
  });

  it("checks again after a network change", async () => {
    const calls = serve({ [PUBLIC]: { json: info }, "GET http://192.168.86.20:8096/Thing": { json: 1 } });
    await request(checked, "/Thing");
    forgetConfirmedServer(); // what the online/offline events do
    await request(checked, "/Thing");
    expect(calls.filter((call) => call.key === PUBLIC)).toHaveLength(2);
  });

  const SAVED: Session = { server: SERVER.url, serverName: "Home", serverVersion: "10.10.7", userId: "abc", userName: "Me", token: "tok" };

  it("refresh gives an older session the Id of the server it reaches", async () => {
    serve({ [PUBLIC]: { json: info }, "GET http://192.168.86.20:8096/Users/Me": { json: { Name: "Me" } } });
    await expect(refresh(SAVED)).resolves.toMatchObject({ serverId: SERVER_ID });
  });

  it("refresh keeps the session but sends no token when another server answers", async () => {
    const calls = serve({ [PUBLIC]: { json: { ...info, Id: "ffffffffffffffffffffffffffffffff" } }, "GET http://192.168.86.20:8096/Users/Me": { json: {} } });
    await expect(refresh({ ...SAVED, serverId: SERVER_ID })).rejects.toMatchObject({ status: 0 });
    expect(calls.map((call) => call.key)).toEqual([PUBLIC]);
  });
});

describe("versionAtLeast", () => {
  it("compares major and minor as numbers", () => {
    expect(versionAtLeast("10.10.7", 10, 10)).toBe(true);
    expect(versionAtLeast("10.9.11", 10, 10)).toBe(false);
    expect(versionAtLeast("10.9.11", 10, 9)).toBe(true);
    expect(versionAtLeast("11.0.0", 10, 10)).toBe(true);
    expect(versionAtLeast("nonsense", 10, 9)).toBe(false);
  });
});

/// A reply that never ends: hands out 1 MB chunks for as long as anyone reads.
function endless() {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(1_000_000));
    },
  });
  return { response: new Response(body), pulls: () => pulls };
}

describe("readCapped", () => {
  it("returns the whole body up to the limit, and stops just past it", async () => {
    await expect(readCapped(new Response("12345"), 5)).resolves.toEqual(new TextEncoder().encode("12345"));
    await expect(readCapped(new Response("123456"), 5)).rejects.toBeInstanceOf(RangeError);
  });

  it("gives up on an endless reply without reading it all", async () => {
    const reply = endless();
    await expect(readCapped(reply.response, 3_000_000)).rejects.toBeInstanceOf(RangeError);
    expect(reply.pulls()).toBeLessThan(10);
  });

  it("refuses a declared Content-Length over the limit before reading", async () => {
    const response = new Response("small", { headers: { "Content-Length": "999999999" } });
    await expect(readCapped(response, 1000)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("request size limits", () => {
  it("turns an endless JSON or subtitle reply into an unreachable error", async () => {
    vi.stubGlobal("fetch", async () => endless().response);
    await expect(request(CONNECTION, "/Items")).rejects.toMatchObject({ status: 0 });
    vi.stubGlobal("fetch", async () => endless().response);
    await expect(request(CONNECTION, "/Sub.vtt", { as: "text" })).rejects.toMatchObject({ status: 0 });
  });

  it("still decodes UTF-8 text and drops a byte-order mark", async () => {
    serve({ "GET http://192.168.86.20:8096/Sub.vtt": { text: "﻿WEBVTT\n\nNaïve" } });
    await expect(request(CONNECTION, "/Sub.vtt", { as: "text" })).resolves.toBe("WEBVTT\n\nNaïve");
  });
});
