// server.js
// npm i express ws rate-limiter-flexible && node server.js

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const { RateLimiterMemory } = require("rate-limiter-flexible");

const PORT = process.env.PORT || 8080;
const SECRET = process.env.CHAT_KEY || "";
const HEARTBEAT = 30000;
const HISTORY_MAX = 200;
const REQUIRE_CODE = process.env.REQUIRE_CODE === "1"; // if true, users without ?g go into a neutral bucket

const app = express();
const here = __dirname;
app.use(express.static(here));
app.get("/", (req, res) => {
  const p = path.join(here, "index.html");
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send("index.html not found");
});
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let idSeq = 0;

// groupId -> { members:Set<nick>, history:Array<evt> }
const groups = new Map();

function qp(req, k, d = null) {
  try { return new URL(req.url, "http://x").searchParams.get(k) ?? d; }
  catch { return d; }
}
function authorized(req){ return !SECRET || qp(req,"key")===SECRET; }

function clientIP(req){
  return (req.headers["cf-connecting-ip"]
       || req.headers["x-real-ip"]
       || req.headers["x-forwarded-for"]
       || req.socket.remoteAddress
       || "").toString();
}

// derive a group from IP blocks when codes are not required
function ipGroup(ip){
  if (!ip) return "nogroup";
  if (ip.includes(".")) { const a = ip.split("."); return `${a[0]}.${a[1]}.${a[2]}`; } // /24
  return ip.split(":").slice(0,4).join(":") || "v6"; // /48-ish
}

function getGroupId(req){
  const code = qp(req, "g");
  if (code && /^[a-z0-9\-_.]{1,32}$/i.test(code)) return `code:${code.toLowerCase()}`;

  // Behind tunnels/proxies, IP may collapse to 127.0.0.1. Avoid mixing everyone.
  if (REQUIRE_CODE) return "code:__global__"; // users with no code share neutral bucket only

  return `ip:${ipGroup(clientIP(req))}`;
}

function ensureGroup(gid){
  if (!groups.has(gid)) groups.set(gid, { members:new Set(), history:[] });
  return groups.get(gid);
}

function broadcast(gid, obj){
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN && c.groupId === gid) c.send(msg);
  }
}

function rosterPayload(gid){
  const g = ensureGroup(gid);
  return { type:"roster", members: Array.from(g.members).sort(), ts: Date.now() };
}

function pushHistory(gid, evt){
  const g = ensureGroup(gid);
  g.history.push(evt);
  if (g.history.length > HISTORY_MAX) g.history.splice(0, g.history.length - HISTORY_MAX);
}
function sendHistory(ws){
  const g = ensureGroup(ws.groupId);
  for (const e of g.history) if (ws.readyState===1) ws.send(JSON.stringify(e));
}

const limiter = new RateLimiterMemory({ points: 10, duration: 3 });

function beat(){ this.isAlive = true; }
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive=false; ws.ping(); }
}, HEARTBEAT);

wss.on("connection", (ws, req) => {
  if (!authorized(req)) { ws.close(1008, "unauthorized"); return; }

  ws.id = (++idSeq).toString(36);
  ws.isAlive = true; ws.on("pong", beat);

  ws.groupId = getGroupId(req);
  const gid = ws.groupId;

  // send current roster snapshot
  if (ws.readyState===1) ws.send(JSON.stringify(rosterPayload(gid)));

  ws.on("message", async (data) => {
    let p; try { p = JSON.parse(data) } catch { return; }

    if (p.type === "hello") {
      if (ws.nickname) return; // lock identity
      let nick = String(p.nickname || `user-${ws.id}`).slice(0,32) || `user-${ws.id}`;
      const g = ensureGroup(gid);
      while (g.members.has(nick)) nick = `${nick}-${ws.id}`;
      ws.nickname = nick;
      g.members.add(nick);

      sendHistory(ws);
      const evt = { type:"system", text:`${nick} joined`, ts:Date.now() };
      pushHistory(gid, evt); broadcast(gid, evt); broadcast(gid, rosterPayload(gid));
      return;
    }

    if (p.type === "chat") {
      try { await limiter.consume(clientIP(req)) } catch { return; }
      const text = String(p.text || "").trim().slice(0,1000);
      if (!text) return;
      const from = ws.nickname || `user-${ws.id}`;
      const evt = { type:"chat", from, text, ts:Date.now() };
      pushHistory(gid, evt); broadcast(gid, evt);
    }
  });

  ws.on("close", () => {
    const g = ensureGroup(gid);
    if (ws.nickname && g.members.has(ws.nickname)) {
      g.members.delete(ws.nickname);
      const evt = { type:"system", text:`${ws.nickname} left`, ts:Date.now() };
      pushHistory(gid, evt); broadcast(gid, evt); broadcast(gid, rosterPayload(gid));
    }
  });
});

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
