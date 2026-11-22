'use strict';
/**
 * Cliente de consola para probar el sistema sin interfaz gráfica.
 *
 * Uso:   node client.js <nombre> [url]
 *        node client.js ana ws://node-a:3000/ws
 *
 * Comandos:  /msg usuario@nodo texto   envía un mensaje de chat
 *            /users                    lista los usuarios conectados
 *            /quit                     sale
 *            {...}                     una línea que empiece con { se envía como JSON crudo
 */
const readline = require('readline');
const { WebSocket } = require('ws');

const name = process.argv[2];
const url = process.argv[3] || 'ws://localhost:3000/ws';
if (!name) { console.error('Uso: node client.js <nombre> [url]'); process.exit(1); }

const ws = new WebSocket(url);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${name}> ` });
const show = text => { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); console.log(text); rl.prompt(true); };

ws.on('open', () => {
  show(`Conectado a ${url}`);
  ws.send(JSON.stringify({ type: 'join', name }));
});

ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  switch (m.type) {
    case 'welcome':  show(`✔ Eres ${m.data.id}. Enlaces con otros nodos: ${m.data.peers.join(', ') || '(ninguno)'}. Usuarios: ${m.data.users.join(', ')}`); break;
    case 'chat':     show(`[${m.from}] ${m.data.text}`); break;
    case 'presence': show(`• ${m.data.user} ${m.data.online ? 'se conectó' : 'se desconectó'}`); break;
    case 'users':    show(`Locales: ${m.data.local.join(', ') || '-'} | Remotos: ${m.data.remote.join(', ') || '-'}`); break;
    case 'error':    show(`✖ ${m.data.code}: ${m.data.message}`); break;
    default:         show(JSON.stringify(m));
  }
});

ws.on('close', () => { console.log('\nConexión cerrada'); process.exit(0); });
ws.on('error', err => { console.error(`No se pudo conectar a ${url}: ${err.message}`); process.exit(1); });

rl.prompt();
rl.on('line', line => {
  const text = line.trim();
  if (text === '/quit') { ws.close(); return; }
  if (text === '/users') ws.send(JSON.stringify({ type: 'users' }));
  else if (text.startsWith('/msg ')) {
    const [, to, ...rest] = text.split(' ');
    ws.send(JSON.stringify({ type: 'chat', to, data: { text: rest.join(' ') } }));
  } else if (text.startsWith('{')) ws.send(text);
  else if (text) show('Comandos: /msg usuario@nodo texto · /users · /quit');
  rl.prompt();
});
