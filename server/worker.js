import { DurableObject } from "cloudflare:workers";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const WORLD_SEEDS = [
  { id: "sky-adventure", name: "Небесное приключение", mode: "adventure", description: "Парящие острова и исследование", players: 0, featured: true },
  { id: "obby-rush", name: "Obby Rush", mode: "obby", description: "Полоса препятствий и испытания", players: 0, featured: true },
  { id: "wild-island", name: "Дикий остров", mode: "survival", description: "Выживание и совместное строительство", players: 0, featured: true }
];
const cleanName = (value) => String(value || "").normalize("NFKC").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 24);
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const fail = (message, status = 400) => json({ error: message }, status);
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
async function digest(value) { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function originAllowed(origin) { return !origin || /^https:\/\/(?:blockverse-2\.pages\.dev|[a-f0-9-]+\.blockverse-2\.pages\.dev)$/.test(origin); }
function cors(request) { const origin = request.headers.get("Origin") || ""; if (!originAllowed(origin)) return {}; return { "access-control-allow-origin": origin || "https://blockverse-2.pages.dev", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", "access-control-allow-headers": "Content-Type,Authorization", "vary": "Origin" }; }
async function bodyJson(request, limit = 8192) { const text = await request.text(); if (text.length > limit) throw new Error("Request body too large"); return text ? JSON.parse(text) : {}; }
function bearer(request) { const value = request.headers.get("Authorization") || ""; return value.startsWith("Bearer ") ? value.slice(7).trim() : ""; }
async function userContext(request, env) { const requestUrl = new URL(request.url); const token = bearer(request) || (requestUrl.pathname === "/ws" ? requestUrl.searchParams.get("token") || "" : ""); if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null; const userId = await digest(token); return { token, userId, stub: env.BLOCKVERSE.getByName("user:" + userId) }; }
async function forward(stub, path, init = {}) { return stub.fetch("https://internal" + path, init); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url), headers = cors(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (url.pathname === "/health") return json({ ok: true, service: "BLOCKVERSE API", version: "1.0.0", timestamp: new Date().toISOString() }, 200, headers);
    if (url.pathname === "/api/session" && request.method === "POST") {
      const token = b64url(crypto.getRandomValues(new Uint8Array(32))), userId = await digest(token);
      const profile = { id: userId, username: "Игрок-" + userId.slice(0, 5).toUpperCase(), avatar: "🧑‍🚀", level: 1, experience: 0, createdAt: new Date().toISOString(), friends: [] };
      const result = await forward(env.BLOCKVERSE.getByName("user:" + userId), "/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(profile) });
      if (!result.ok) return fail("Не удалось создать профиль", 503);
      return json({ token, profile }, 201, headers);
    }
    if (url.pathname === "/api/worlds" && request.method === "GET") {
      const r = await forward(env.BLOCKVERSE.getByName("registry"), "/worlds");
      const data = await r.json();
      return json({ worlds: data.worlds || WORLD_SEEDS }, 200, headers);
    }
    if (url.pathname === "/api/worlds" && request.method === "POST") {
      const auth = await userContext(request, env); if (!auth) return fail("Требуется сессия игрока", 401);
      let data; try { data = await bodyJson(request); } catch { return fail("Некорректный JSON", 400); }
      const name = cleanName(data.name), mode = ["adventure", "obby", "survival", "sandbox"].includes(data.mode) ? data.mode : "sandbox";
      if (name.length < 3) return fail("Название должно содержать от 3 символов", 422);
      const r = await forward(env.BLOCKVERSE.getByName("registry"), "/worlds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mode, description: String(data.description || "").slice(0, 120), ownerId: auth.userId }) });
      const result = await r.json(); return json(result, r.status, headers);
    }
    const stateMatch = url.pathname.match(/^\/api\/worlds\/([a-z0-9-]+)\/state$/);
    if (stateMatch && (request.method === "GET" || request.method === "PATCH")) {
      const auth = await userContext(request, env); if (!auth) return fail("Сессия не найдена", 401);
      let payload = {};
      if (request.method === "PATCH") { try { payload = await bodyJson(request, 32000); } catch { return fail("Некорректный JSON", 400); } }
      const r = await forward(env.BLOCKVERSE.getByName("registry"), "/world-state?id=" + encodeURIComponent(stateMatch[1]) + "&ownerId=" + auth.userId, { method: request.method, headers: { "content-type": "application/json" }, body: request.method === "PATCH" ? JSON.stringify(payload) : undefined });
      return new Response(await r.text(), { status: r.status, headers: { ...JSON_HEADERS, ...headers } });
    }
    if (url.pathname === "/api/me" && request.method === "GET") {
      const auth = await userContext(request, env); if (!auth) return fail("Сессия не найдена", 401);
      const r = await forward(auth.stub, "/profile"); return new Response(await r.text(), { status: r.status, headers: { ...JSON_HEADERS, ...headers } });
    }
    if (url.pathname === "/api/profile" && request.method === "PATCH") {
      const auth = await userContext(request, env); if (!auth) return fail("Сессия не найдена", 401);
      let data; try { data = await bodyJson(request); } catch { return fail("Некорректный JSON", 400); }
      const patch = {};
      if (data.username !== undefined) { const username = cleanName(data.username); if (username.length < 3) return fail("Имя должно содержать минимум 3 символа", 422); patch.username = username; }
      if (data.avatar !== undefined) { const avatar = String(data.avatar); if (!["🧑‍🚀","🤖","🦊","🐼","🐸","🐱","🧙","👾"].includes(avatar)) return fail("Недопустимый аватар", 422); patch.avatar = avatar; }
      const r = await forward(auth.stub, "/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      return new Response(await r.text(), { status: r.status, headers: { ...JSON_HEADERS, ...headers } });
    }
    if (url.pathname === "/api/friends" && (request.method === "GET" || request.method === "POST")) {
      const auth = await userContext(request, env); if (!auth) return fail("Сессия не найдена", 401);
      if (request.method === "GET") { const r = await forward(auth.stub, "/friends"); return new Response(await r.text(), { status: r.status, headers: { ...JSON_HEADERS, ...headers } }); }
      let data; try { data = await bodyJson(request); } catch { return fail("Некорректный JSON", 400); }
      const friendId = String(data.accountId || "");
      if (!/^[a-f0-9]{64}$/.test(friendId) || friendId === auth.userId) return fail("Проверь ID игрока", 422);
      const target = env.BLOCKVERSE.getByName("user:" + friendId);
      const targetResponse = await forward(target, "/profile");
      if (!targetResponse.ok) return fail("Игрок не найден", 404);
      const targetProfile = await targetResponse.json();
      const r = await forward(auth.stub, "/friends", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: friendId, username: targetProfile.username, avatar: targetProfile.avatar }) });
      return new Response(await r.text(), { status: r.status, headers: { ...JSON_HEADERS, ...headers } });
    }
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return fail("WebSocket upgrade required", 426);
      const auth = await userContext(request, env); if (!auth) return fail("Требуется действующая сессия", 401);
      const worldId = String(url.searchParams.get("world") || "sky-adventure").replace(/[^a-z0-9-]/g, "").slice(0, 48);
      if (!worldId) return fail("Некорректный мир", 400);
      const profileResponse = await forward(auth.stub, "/profile");
      if (!profileResponse.ok) return fail("Профиль не найден", 401);
      const profile = await profileResponse.json();
      const target = env.BLOCKVERSE.getByName("room:" + worldId);
      const internalUrl = new URL(request.url); internalUrl.pathname = "/room"; internalUrl.searchParams.set("userId", auth.userId); internalUrl.searchParams.set("username", profile.username); internalUrl.searchParams.set("avatar", profile.avatar);
      return target.fetch(new Request(internalUrl, request));
    }
    return fail("Маршрут не найден", 404);
  }
};

export class BlockverseDurable extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/profile") {
      if (request.method === "GET") { const p = await this.ctx.storage.get("profile"); return p ? json(p) : fail("Профиль не найден", 404); }
      if (request.method === "PUT") { const p = await request.json(); await this.ctx.storage.put("profile", p); return json(p, 201); }
      if (request.method === "PATCH") { const old = await this.ctx.storage.get("profile"); if (!old) return fail("Профиль не найден", 404); const patch = await request.json(); const next = { ...old, ...patch }; await this.ctx.storage.put("profile", next); return json(next); }
    }
    if (url.pathname === "/friends") {
      const profile = await this.ctx.storage.get("profile"); if (!profile) return fail("Профиль не найден", 404);
      if (request.method === "GET") return json({ friends: profile.friends || [] });
      if (request.method === "POST") { const friend = await request.json(); const friends = profile.friends || []; if (friends.some(x => x.id === friend.id)) return fail("Игрок уже в друзьях", 409); friends.push({ id: friend.id, username: friend.username, avatar: friend.avatar, addedAt: new Date().toISOString() }); profile.friends = friends.slice(-200); await this.ctx.storage.put("profile", profile); return json({ friends: profile.friends }, 201); }
    }
    if (url.pathname === "/world-state") {
      const id = url.searchParams.get("id") || "", ownerId = url.searchParams.get("ownerId") || "";
      const worlds = await this.ctx.storage.get("worlds") || [], world = worlds.find(item => item.id === id);
      if (!world || (request.method === "PATCH" && world.ownerId !== ownerId)) return fail("Мир не найден или нет прав на редактирование", 404);
      const key = "world-state:" + id;
      if (request.method === "GET") return json({ blocks: await this.ctx.storage.get(key) || [] });
      if (request.method === "PATCH") {
        const data = await request.json(), blocks = data.blocks;
        if (!Array.isArray(blocks) || blocks.length > 400) return fail("Допустимо не более 400 объектов", 422);
        const safe = [];
        for (const item of blocks) {
          if (!item || !["cube","platform","tree","lamp"].includes(item.type)) return fail("Недопустимый тип объекта", 422);
          const x = Number(item.x), y = Number(item.y), z = Number(item.z);
          if (![x,y,z].every(Number.isFinite) || Math.abs(x) > 100 || y < 0 || y > 50 || Math.abs(z) > 100) return fail("Координаты вне границ мира", 422);
          safe.push({ id: String(item.id || crypto.randomUUID()).slice(0,64), type: item.type, x, y, z });
        }
        await this.ctx.storage.put(key, safe);
        return json({ saved: true, count: safe.length, blocks: safe });
      }
    }
    if (url.pathname === "/worlds") {
      if (request.method === "GET") { const custom = await this.ctx.storage.get("worlds") || []; return json({ worlds: [...WORLD_SEEDS, ...custom] }); }
      if (request.method === "POST") { const data = await request.json(), worlds = await this.ctx.storage.get("worlds") || []; if (worlds.length >= 500) return fail("Достигнут лимит пользовательских миров", 429); const world = { id: crypto.randomUUID().replace(/-/g, ""), name: data.name, mode: data.mode, description: data.description, ownerId: data.ownerId, players: 0, featured: false, createdAt: new Date().toISOString() }; worlds.push(world); await this.ctx.storage.put("worlds", worlds); return json({ world }, 201); }
    }
    if (url.pathname === "/room") return this.roomFetch(request, url);
    return fail("Маршрут не найден", 404);
  }
  async roomFetch(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") return fail("WebSocket upgrade required", 426);
    const userId = url.searchParams.get("userId") || "", username = String(url.searchParams.get("username") || "Игрок").slice(0, 24), avatar = url.searchParams.get("avatar") || "🧑‍🚀";
    if (!/^[a-f0-9]{64}$/.test(userId)) return fail("Неавторизованный игрок", 401);
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    const existing = this.ctx.getWebSockets().map(ws => { try { return ws.deserializeAttachment(); } catch { return null; } }).filter(Boolean);
    const player = { id: userId, username, avatar, x: 0, z: 0, yaw: 0, joinedAt: Date.now(), lastMove: 0, lastChat: 0 };
    this.ctx.acceptWebSocket(server); server.serializeAttachment(player);
    const history = await this.ctx.storage.get("chat") || [];
    server.send(JSON.stringify({ type: "welcome", player, players: existing, history }));
    this.broadcast({ type: "player_joined", player: this.publicPlayer(player) }, server);
    return new Response(null, { status: 101, webSocket: client });
  }
  publicPlayer(p) { return { id: p.id, username: p.username, avatar: p.avatar, x: p.x, z: p.z, yaw: p.yaw }; }
  broadcast(message, except) { const payload = JSON.stringify(message); for (const ws of this.ctx.getWebSockets()) if (ws !== except && ws.readyState === 1) { try { ws.send(payload); } catch {} } }
  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 1200) return;
    let data; try { data = JSON.parse(message); } catch { return; }
    let player; try { player = ws.deserializeAttachment(); } catch { return; } if (!player) return;
    if (data.type === "move") {
      const x = Number(data.x), z = Number(data.z), yaw = Number(data.yaw), now = Date.now();
      if (![x,z,yaw].every(Number.isFinite) || now - player.lastMove < 40) return;
      const elapsed = Math.max(40, now - (player.lastMove || now - 100));
      const distance = Math.hypot(x - player.x, z - player.z);
      if (distance > Math.min(2.5, elapsed * 0.012 + 0.35)) return;
      player.x = Math.max(-100, Math.min(100, x)); player.z = Math.max(-100, Math.min(100, z)); player.yaw = yaw; player.lastMove = now;
      ws.serializeAttachment(player);
      this.broadcast({ type: "player_moved", player: this.publicPlayer(player) }, ws);
      return;
    }
    if (data.type === "chat") {
      const now = Date.now(), text = String(data.text || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240);
      if (!text || now - player.lastChat < 650) return;
      player.lastChat = now; ws.serializeAttachment(player);
      const message = { id: crypto.randomUUID(), userId: player.id, username: player.username, avatar: player.avatar, text, createdAt: new Date(now).toISOString() };
      const history = await this.ctx.storage.get("chat") || []; history.push(message); await this.ctx.storage.put("chat", history.slice(-100));
      this.broadcast({ type: "chat", message });
    }
  }
  async webSocketClose(ws) { let p; try { p = ws.deserializeAttachment(); } catch {} if (p) this.broadcast({ type: "player_left", id: p.id }); }
  async webSocketError(ws) { await this.webSocketClose(ws); }
}
