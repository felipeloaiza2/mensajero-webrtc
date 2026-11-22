'use strict';
/**
 * Prueba de extremo a extremo SIN Docker: levanta dos nodos como procesos locales,
 * conecta dos clientes (uno por nodo) y verifica que los mensajes crucen entre nodos.
 * Uso: npm test
 */
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { WebSocket } = require('ws');

const server = path.join(__dirname, '..', 'server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];

function startNode(id, port, peer) {
  const p = spawn(process.execPath, [server], {
    env: { ...process.env, NODE_ID: id, PORT: String(port), PEER_URL: peer || '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  p.stdout.on('data', d => process.stdout.write(d));
  procs.push(p);
  return p;
}

function client(port, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.inbox = [];
    ws.on('message', raw => ws.inbox.push(JSON.parse(raw.toString())));
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'join', name })); resolve(ws); });
    ws.on('error', reject);
  });
}
const waitFor = async (ws, pred, label) => {
  for (let i = 0; i < 40; i++) { const m = ws.inbox.find(pred); if (m) return m; await sleep(50); }
  throw new Error(`No llegó: ${label}`);
};

(async () => {
  try {
    startNode('node-b', 3102);                                  // acepta el enlace
    await sleep(400);
    startNode('node-a', 3101, 'ws://localhost:3102/peer');       // abre el enlace hacia node-b
    await sleep(1200);

    const ana = await client(3101, 'ana');
    const beto = await client(3102, 'beto');
    await waitFor(ana, m => m.type === 'presence' && m.data.user === 'beto@node-b', 'presencia de beto en el nodo A');
    console.log('✔ presencia remota recibida');

    ana.send(JSON.stringify({ type: 'chat', to: 'beto@node-b', data: { text: 'hola desde A' } }));
    const got = await waitFor(beto, m => m.type === 'chat', 'chat A→B');
    assert.strictEqual(got.from, 'ana@node-a');
    assert.strictEqual(got.data.text, 'hola desde A');
    console.log('✔ chat A → B cruzó entre nodos');

    beto.send(JSON.stringify({ type: 'chat', to: 'ana@node-a', data: { text: 'hola desde B' } }));
    const back = await waitFor(ana, m => m.type === 'chat', 'chat B→A');
    assert.strictEqual(back.from, 'beto@node-b');
    console.log('✔ chat B → A cruzó entre nodos');

    ana.send(JSON.stringify({ type: 'chat', to: 'nadie@node-b', data: { text: 'x' } }));
    const err = await waitFor(ana, m => m.type === 'error', 'error de usuario inexistente');
    assert.strictEqual(err.data.code, 'user_offline');
    console.log('✔ usuario inexistente → error user_offline');

    ana.send(JSON.stringify({ type: 'offer', to: 'beto@node-b', data: { sdp: 'v=0' } }));
    const offer = await waitFor(beto, m => m.type === 'offer', 'offer A→B');
    assert.strictEqual(offer.data.sdp, 'v=0');
    console.log('✔ mensaje de señalización (offer) reenviado entre nodos');

    beto.close();
    await waitFor(ana, m => m.type === 'presence' && m.data.user === 'beto@node-b' && m.data.online === false, 'desconexión de beto');
    console.log('✔ desconexión remota notificada');
    console.log('\nTodas las pruebas pasaron');
    ana.close();
    process.exitCode = 0;
  } catch (e) {
    console.error('✖ Falló la prueba:', e.message);
    process.exitCode = 1;
  } finally {
    procs.forEach(p => p.kill('SIGTERM'));
  }
})();
