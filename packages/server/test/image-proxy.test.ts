// http:// images fetched by the server for the reader (D-140).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";
import { IMAGE_MAX_BYTES } from "../src/reader/imageProxy.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("image proxy", () => {
  let server: http.Server;
  let origin: string;
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let cookie: string;
  const seen: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url!);
      if (req.url === "/a.png") res.writeHead(200, { "content-type": "image/png" }).end(PNG);
      else if (req.url === "/page") res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
      else if (req.url === "/x.svg") res.writeHead(200, { "content-type": "image/svg+xml" }).end("<svg/>");
      else if (req.url === "/huge.png") res.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(IMAGE_MAX_BYTES + 1));
      else res.writeHead(404).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The test server is on loopback, so it must be allowed like an internal feed would be.
    app = await createTestApp("sqlite", { FA_ALLOWED_INTERNAL_ORIGINS: origin });
    const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", headers: CSRF, payload: { setupCode: SETUP_CODE, username: "admin", password: "isolated test password" } });
    cookie = sessionCookie(setup)!;
  });
  afterAll(async () => {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  const get = (target: string, withCookie = true) =>
    app.fastify.inject({ method: "GET", url: `/api/image?url=${encodeURIComponent(target)}`, headers: withCookie ? { cookie } : {} });

  it("serves an http:// image with headers that keep it inert", async () => {
    const res = await get(`${origin}/a.png`);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=86400",
    });
  });

  it("needs a login", async () => {
    expect((await get(`${origin}/a.png`, false)).statusCode).toBe(401);
  });

  it("refuses https, other schemes and credentials, so it isn't a general proxy", async () => {
    for (const target of ["https://img.example/a.png", "file:///etc/passwd", `http://user:pw@127.0.0.1/a.png`, "not a url"]) {
      expect((await get(target)).statusCode).toBe(400);
    }
  });

  it("refuses private addresses that aren't allowed, before connecting", async () => {
    const before = seen.length;
    const res = await get("http://10.1.2.3/a.png");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("blocked_destination");
    expect(seen.length).toBe(before);
  });

  it("only passes raster images: not pages, not SVG, not oversized files", async () => {
    expect((await get(`${origin}/page`)).statusCode).toBe(415);
    expect((await get(`${origin}/x.svg`)).statusCode).toBe(415);
    expect((await get(`${origin}/huge.png`)).statusCode).toBe(413);
    expect((await get(`${origin}/missing.png`)).statusCode).toBe(502);
  });
});
