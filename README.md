# Mensajero WebRTC en contenedores Docker

Laboratorio de Sistemas Distribuidos · Universidad Tecnológica de Pereira
Estudiante: Jhon Felipe Loaiza Restrepo · Docente: Felipe Gutiérrez Isaza

> **Estado: primer avance (Fase 2), sin interfaz gráfica.** Dos nodos en contenedores Docker se comunican por nombre y se intercambian mensajes de texto. La interfaz, la videollamada y los archivos llegan en la Fase 3.

El diseño completo y las fuentes están en el informe de investigación: [`docs/Informe_Investigacion.pdf`](docs/Informe_Investigacion.pdf). Los diagramas UML (PlantUML) están en [`docs/uml/`](docs/uml/).

## Requisitos

- Windows con **Docker Desktop** en ejecución (incluye Docker Compose v2).
- Opcional, para probar con `wscat` desde Windows: Node.js (`npx wscat`). No es necesario: el contenedor ya trae un cliente de consola.

## Ejecutar

```powershell
docker compose up --build
```

Esto construye la imagen una vez y levanta los dos nodos. Para detener y limpiar:

```powershell
docker compose down
```

## Puertos

| Servicio | Puerto en el contenedor | Puerto en Windows | Uso |
|---|---|---|---|
| `node-a` | 3000 | **8081** | HTTP (`/health`, `/api/users`) y WebSocket (`/ws`) |
| `node-b` | 3000 | **8082** | igual |

El enlace entre nodos (`ws://node-b:3000/peer`) usa el puerto 3000 **dentro** de la red Docker `mensajero-net`; no se publica. Si 8081 u 8082 están ocupados, cambia el número de la izquierda en `docker-compose.yml`.

## Cómo se encuentran los nodos

`node-a` abre el enlace hacia `ws://node-b:3000/peer`. El nombre `node-b` es el del servicio de Compose, que el DNS interno de Docker resuelve dentro de la red `mensajero-net` (bridge definida por el usuario). No hay ninguna IP escrita en el código.

## Probar este avance (sin interfaz)

Los usuarios se identifican como `nombre@nodo` (por ejemplo `ana@node-a`).

### 1. Los dos nodos están vivos y enlazados

```powershell
curl.exe http://localhost:8081/health
curl.exe http://localhost:8082/health
```

Cada respuesta debe mostrar `"peers":["node-b"]` (en el nodo A) y `"peers":["node-a"]` (en el nodo B).

### 2. Se resuelven por nombre

```powershell
docker compose exec node-a wget -qO- http://node-b:3000/health
```

### 3. Intercambio de mensajes desde la consola

Abre **dos terminales** de PowerShell en la carpeta del proyecto.

Terminal 1:

```powershell
docker compose exec node-a node client.js ana ws://localhost:3000/ws
```

Terminal 2:

```powershell
docker compose exec node-b node client.js beto ws://localhost:3000/ws
```

En la terminal 1 escribe:

```
/msg beto@node-b hola desde el nodo A
```

`beto` lo recibe en la terminal 2. Responde desde allí con `/msg ana@node-a hola desde el nodo B`. Otros comandos: `/users` (lista de conectados) y `/quit`.

### 4. Lo mismo con `wscat` (opcional)

```powershell
npx wscat -c ws://localhost:8081/ws
```

y luego, pegando cada línea:

```json
{"type":"join","name":"ana"}
{"type":"chat","to":"beto@node-b","data":{"text":"hola"}}
```

### 5. Ver los logs de ambos nodos

```powershell
docker compose logs -f
```

Un mensaje de `ana@node-a` a `beto@node-b` deja estas líneas (cada una lleva la hora delante):

```
node-a  | [node-a] reenvío   chat ana@node-a → beto@node-b (por enlace con node-b)
node-b  | [node-b] entrega   chat ana@node-a → beto@node-b (llegó por enlace con node-a)
```

### 6. Quién está conectado (HTTP)

```powershell
curl.exe http://localhost:8081/api/users
```

### Prueba automática (sin Docker)

Con Node.js instalado: `cd server`, `npm install` y `npm test`. Levanta dos nodos como procesos locales y comprueba el reenvío de mensajes entre ellos.

## Mensajes (JSON)

Formato común: `{ "v":1, "type":"...", "id":"...", "from":"ana@node-a", "to":"beto@node-b", "ts":1763312000000, "data":{...} }`

| `type` | Quién lo envía | Qué hace |
|---|---|---|
| `join` | cliente | `{"type":"join","name":"ana"}`: se registra y recibe `welcome` |
| `chat` | cliente | mensaje de texto a `to`, en `data.text` |
| `offer`, `answer`, `candidate`, `hangup` | cliente | señalización WebRTC dirigida a `to` (se usarán en la Fase 3) |
| `users` | cliente | pide la lista de usuarios conectados |
| `presence` | nodo | un usuario se conectó o se desconectó |
| `error` | nodo | `data.code` y `data.message` (`user_offline`, `name_taken`, `node_unreachable`…) |

El servidor fija `from` con la identidad real del emisor; el cliente no puede suplantarla.

## Estructura

```
.
├── docker-compose.yml     dos nodos y la red mensajero-net
├── server/
│   ├── Dockerfile         imagen única para ambos nodos
│   ├── server.js          HTTP + WebSocket /ws (clientes) y /peer (otros nodos)
│   ├── client.js          cliente de consola para las pruebas
│   ├── public/            página estática del nodo (placeholder de la Fase 3)
│   └── test/e2e.js        prueba automática local
├── docs/
│   ├── Informe_Investigacion.pdf
│   └── uml/               fuentes PlantUML
└── BITACORA.md
```

## Problemas conocidos

- Aún no hay interfaz gráfica, videollamada ni archivos (Fase 3).
- El enlace entre nodos lo abre solo `node-a` (por eso solo `node-a` tiene `PEER_URL`). Con más nodos habría que decidir quién abre cada enlace.
- Los mensajes no se guardan: si el destinatario no está conectado, el emisor recibe `user_offline`.
- Si `node-b` se cae, `node-a` reintenta el enlace con espera creciente (1, 2, 4, 8 y 10 s) y lo restablece solo.
