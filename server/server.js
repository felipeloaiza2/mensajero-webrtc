'use strict';
/**
 * Servidor de señalización del mensajero WebRTC (un proceso = un nodo).
 *
 *  - HTTP  : sirve ./public y expone /health y /api/users.
 *  - /ws   : WebSocket para los clientes (navegadores, wscat, client.js).
 *  - /peer : WebSocket para los OTROS nodos. Cada nodo abre el enlace hacia los
 *            nodos de PEER_URL usando el nombre del servicio (ej. node-b), no una IP.
 *
 * Identidad de usuario: "nombre@nodo" (ej. ana@node-a). El nodo del destinatario decide
 * si el mensaje se entrega localmente o se reenvía por el enlace /peer.
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

// ───────────── Configuración (variables de entorno) ─────────────
const NODE_ID = process.env.NODE_ID || 'node-local';
const PORT = Number(process.env.PORT) || 3000;
// Lista separada por comas de nodos a los que ESTE nodo abre el enlace. Puede ir vacía.
const PEER_URLS = (process.env.PEER_URL || '').split(',').map(s => s.trim()).filter(Boolean);
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DIRECTED = new Set(['chat', 'offer', 'answer', 'candidate', 'hangup']); // mensajes con destinatario
const MAX_PAYLOAD = 256 * 1024; // un SDP ocupa pocos KB; 256 KB sobra
const HEARTBEAT_MS = 15000;

// ───────────── Registro de eventos (logs) ─────────────
function log(event, detail = '') {
  console.log(`${new Date().toISOString()} [${NODE_ID}] ${event.padEnd(14)} ${detail}`);
}

// ───────────── Estado del nodo ─────────────
const clients = new Map();      // nombre local  -> WebSocket del cliente
const remoteUsers = new Map();  // "nombre@nodo" -> id del nodo remoto donde está conectado
const peers = new Map();        // id del nodo remoto -> WebSocket del enlace (/peer)
const outbound = new Set();     // enlaces que ESTE nodo abrió (también necesitan latido)
let closing = false;            // true durante el apagado: no reintentar enlaces

const idOf = name => `${name}@${NODE_ID}`;
const nodeOf = id => id.slice(id.lastIndexOf('@') + 1);
const send = (ws, obj) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
const sendError = (ws, code, message, ref) => send(ws, { v: 1, type: 'error', ts: Date.now(), data: { code, message, ref } });

// ───────────── Servidor HTTP ─────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => {
  res.json({ ok: true, node: NODE_ID, peers: [...peers.keys()], localUsers: clients.size });
});
app.get('/api/users', (req, res) => {
  res.json({ node: NODE_ID, local: [...clients.keys()].map(idOf), remote: [...remoteUsers.keys()] });
});
const server = http.createServer(app);

// ───────────── WebSocket: dos rutas sobre el mismo puerto ─────────────
const wssClients = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
const wssPeers = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const target = pathname === '/ws' ? wssClients : pathname === '/peer' ? wssPeers : null;
  if (!target) { socket.destroy(); return; }
  target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws, req));
});

// Latido: detecta conexiones muertas (cierre brusco, red caída)
function heartbeat(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}
const heartbeatTimer = setInterval(() => {
  for (const ws of [...wssClients.clients, ...wssPeers.clients, ...outbound]) {
    if (ws.isAlive === undefined) continue; // aún sin inicializar
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

// ───────────── Clientes (/ws) ─────────────
wssClients.on('connection', (ws, req) => {
  heartbeat(ws);
  ws.userName = null;
  log('cliente+', `conectado desde ${req.socket.remoteAddress}`);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return sendError(ws, 'bad_json', 'El mensaje no es JSON válido'); }
    if (!msg || typeof msg.type !== 'string') return sendError(ws, 'bad_message', 'Falta el campo "type"');

    if (msg.type === 'join') return handleJoin(ws, msg);
    if (!ws.userName) return sendError(ws, 'not_joined', 'Envía primero {"type":"join","name":"..."}', msg.id);

    if (msg.type === 'users') {
      return send(ws, { v: 1, type: 'users', ts: Date.now(), data: { local: [...clients.keys()].map(idOf), remote: [...remoteUsers.keys()] } });
    }
    if (DIRECTED.has(msg.type)) return routeDirected(ws, msg);
    sendError(ws, 'unknown_type', `Tipo no soportado: ${msg.type}`, msg.id);
  });

  ws.on('close', () => {
    if (ws.userName && clients.get(ws.userName) === ws) {
      clients.delete(ws.userName);
      log('cliente-', `${idOf(ws.userName)} se desconectó`);
      announce(idOf(ws.userName), false);
    }
  });
  ws.on('error', err => log('cliente!', err.message));
});

function handleJoin(ws, msg) {
  const name = msg.name ?? msg.data?.name;
  if (ws.userName) return sendError(ws, 'already_joined', 'Ya te uniste con otro nombre');
  if (typeof name !== 'string' || !NAME_RE.test(name)) return sendError(ws, 'bad_name', 'Nombre inválido (letras, números, - y _; máx. 32)');
  if (clients.has(name)) return sendError(ws, 'name_taken', `El nombre ${name} ya está en uso en ${NODE_ID}`);
  ws.userName = name;
  clients.set(name, ws);
  const id = idOf(name);
  log('join', `${id}`);
  send(ws, { v: 1, type: 'welcome', ts: Date.now(), data: { id, node: NODE_ID, peers: [...peers.keys()], users: [...clients.keys()].map(idOf).concat([...remoteUsers.keys()]) } });
  announce(id, true);
}

// Avisa presencia (conectado / desconectado) a los clientes locales y a los otros nodos
function announce(userId, online) {
  const note = { v: 1, type: 'presence', ts: Date.now(), data: { user: userId, online } };
  for (const c of clients.values()) send(c, note);
  for (const p of peers.values()) send(p, note);
}

// Enrutamiento de un mensaje dirigido (from → to)
function routeDirected(ws, msg) {
  const from = idOf(ws.userName);
  const to = msg.to;
  if (typeof to !== 'string' || !to.includes('@')) return sendError(ws, 'bad_to', 'El campo "to" debe ser nombre@nodo', msg.id);
  const out = { v: 1, type: msg.type, id: msg.id || crypto.randomUUID(), from, to, ts: Date.now(), data: msg.data ?? {} };
  const destNode = nodeOf(to);

  if (destNode === NODE_ID) {                     // destinatario en ESTE nodo
    const dest = clients.get(to.slice(0, to.lastIndexOf('@')));
    if (!dest) return sendError(ws, 'user_offline', `${to} no está conectado`, msg.id);
    send(dest, out);
    log('entrega', `${msg.type} ${from} → ${to} (local)`);
  } else {                                        // destinatario en OTRO nodo: reenviar por /peer
    const link = peers.get(destNode);
    if (!link) return sendError(ws, 'node_unreachable', `No hay enlace con el nodo ${destNode}`, msg.id);
    send(link, out);
    log('reenvío', `${msg.type} ${from} → ${to} (por enlace con ${destNode})`);
  }
}

// ───────────── Enlace entre nodos (/peer) ─────────────
// Mensajes del enlace: hello, presence-sync, presence y los mensajes dirigidos ya enrutados.
function attachPeer(ws, origin) {
  heartbeat(ws);
  ws.peerNode = null;
  send(ws, { v: 1, type: 'hello', ts: Date.now(), data: { node: NODE_ID } });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hello') {
      const remote = msg.data?.node;
      if (!remote || remote === NODE_ID) return ws.close();
      if (peers.has(remote) && peers.get(remote) !== ws) peers.get(remote).terminate(); // evita enlaces duplicados
      ws.peerNode = remote;
      peers.set(remote, ws);
      log('enlace+', `${origin} con ${remote} establecido`);
      send(ws, { v: 1, type: 'presence-sync', ts: Date.now(), data: { users: [...clients.keys()].map(idOf) } });
      return;
    }
    if (!ws.peerNode) return; // ignorar todo hasta recibir el hello

    if (msg.type === 'presence-sync') {
      for (const [id, n] of remoteUsers) if (n === ws.peerNode) remoteUsers.delete(id);
      for (const id of msg.data?.users || []) remoteUsers.set(id, ws.peerNode);
      log('presencia', `sincronizada con ${ws.peerNode}: ${(msg.data?.users || []).join(', ') || '(nadie)'}`);
      return;
    }
    if (msg.type === 'presence') {
      const { user, online } = msg.data || {};
      if (!user) return;
      if (online) remoteUsers.set(user, ws.peerNode); else remoteUsers.delete(user);
      log('presencia', `${user} ${online ? 'conectado' : 'desconectado'} (nodo ${ws.peerNode})`);
      for (const c of clients.values()) send(c, msg); // los clientes locales también se enteran
      return;
    }
    if (DIRECTED.has(msg.type)) {                  // mensaje que llega desde otro nodo para un usuario local
      const dest = clients.get((msg.to || '').slice(0, (msg.to || '').lastIndexOf('@')));
      if (nodeOf(msg.to || '') !== NODE_ID || !dest) {
        log('descarte', `${msg.type} para ${msg.to}: no está en este nodo`);
        return send(ws, { v: 1, type: 'undeliverable', ts: Date.now(), data: { to: msg.to, from: msg.from, ref: msg.id } });
      }
      send(dest, msg);
      log('entrega', `${msg.type} ${msg.from} → ${msg.to} (llegó por enlace con ${ws.peerNode})`);
      return;
    }
    if (msg.type === 'undeliverable') {            // el otro nodo no encontró al destinatario
      const src = clients.get((msg.data?.from || '').slice(0, (msg.data?.from || '').lastIndexOf('@')));
      if (src) sendError(src, 'user_offline', `${msg.data.to} no está conectado`, msg.data.ref);
    }
  });

  ws.on('close', () => {
    if (ws.peerNode && peers.get(ws.peerNode) === ws) {
      peers.delete(ws.peerNode);
      for (const [id, n] of remoteUsers) if (n === ws.peerNode) remoteUsers.delete(id);
      log('enlace-', `se perdió el enlace con ${ws.peerNode}`);
    }
  });
  ws.on('error', err => log('enlace!', err.message));
}

// Conexión entrante: otro nodo nos abrió el enlace
wssPeers.on('connection', (ws, req) => attachPeer(ws, `entrante (${req.socket.remoteAddress})`));

// Conexión saliente: ESTE nodo abre el enlace con reintentos y espera creciente
function connectToPeer(url, attempt = 0) {
  if (closing) return;
  const ws = new WebSocket(url, { maxPayload: MAX_PAYLOAD });
  outbound.add(ws);
  let opened = false;
  ws.on('open', () => { opened = true; attachPeer(ws, `saliente (${url})`); });
  ws.on('error', err => { if (!opened) log('enlace!', `${url}: ${err.code || err.message}`); });
  ws.on('close', () => {
    outbound.delete(ws);
    if (closing) return;
    const wait = Math.min(1000 * 2 ** attempt, 10000);   // 1 s, 2 s, 4 s, 8 s, 10 s, 10 s…
    log('reintento', `${url} en ${wait / 1000} s`);
    setTimeout(() => connectToPeer(url, opened ? 0 : attempt + 1), wait);
  });
}

// ───────────── Arranque y apagado ordenado ─────────────
server.listen(PORT, () => {
  log('arranque', `escuchando en :${PORT} · enlaces salientes: ${PEER_URLS.join(', ') || '(ninguno)'}`);
  PEER_URLS.forEach(u => connectToPeer(u));
});

function shutdown(signal) {
  log('apagado', `${signal} recibido, cerrando…`);
  closing = true;
  clearInterval(heartbeatTimer);
  for (const ws of [...wssClients.clients, ...wssPeers.clients, ...outbound]) ws.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM')); // docker stop
process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C
