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

const members = new Set();
const history = [];

function qp(req, k, d=null){ try{ return new URL(req.url,"http://x").searchParams.get(k) ?? d }catch{ return d } }
function authorized(req){ return !SECRET || qp(req,"key")===SECRET }

function broadcast(obj){
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}
function rosterPayload(){
  return { type:"roster", members: Array.from(members).sort(), ts: Date.now() };
}
function pushHistory(evt){
  history.push(evt);
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
}
function sendHistory(ws){ for (const e of history) if (ws.readyState===1) ws.send(JSON.stringify(e)); }

const limiter = new RateLimiterMemory({ points: 10, duration: 3 });

function beat(){ this.isAlive = true; }
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive=false; ws.ping(); }
}, HEARTBEAT);

wss.on("connection", (ws, req) => {
  if (!authorized(req)) { ws.close(1008, "unauthorized"); return; }

  const id = (++idSeq).toString(36);
  ws.isAlive = true; ws.on("pong", beat);
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString();

  if (ws.readyState===1) ws.send(JSON.stringify(rosterPayload()));

  ws.on("message", async (data) => {
    let p; try { p = JSON.parse(data) } catch { return; }

    if (p.type === "hello") {
      if (ws.nickname) return;
      let nick = String(p.nickname || `user-${id}`).slice(0,32) || `user-${id}`;
      if (members.has(nick)) nick = `${nick}-${id}`;
      ws.nickname = nick;
      members.add(nick);

      sendHistory(ws);
      const evt = { type:"system", text:`${nick} joined`, ts:Date.now() };
      pushHistory(evt); broadcast(evt); broadcast(rosterPayload());
      return;
    }

    if (p.type === "chat") {
      try { await limiter.consume(ip) } catch { return; }
      const text = String(p.text || "").trim().slice(0,1000);
      if (!text) return;
      const from = ws.nickname || `user-${id}`;
      const evt = { type:"chat", from, text, ts:Date.now() };
      pushHistory(evt); broadcast(evt);
    }
  });

  ws.on("close", () => {
    if (!ws.nickname) return;
    members.delete(ws.nickname);
    const evt = { type:"system", text:`${ws.nickname} left`, ts:Date.now() };
    pushHistory(evt); broadcast(evt); broadcast(rosterPayload());
  });
});

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
