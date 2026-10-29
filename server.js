// 달걀 도둑 3D 온라인 서버 (최대 5명)
// 실행: node server.js        (포트를 바꾸려면: node server.js 9000)
// 같은 와이파이의 친구들은 브라우저에서 http://<이 컴퓨터 IP>:8080 으로 접속하면 돼요.
// 추가 설치 없이 Node.js 기본 기능만 사용해요.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = +process.argv[2] || +process.env.PORT || 8080;
const GAME = path.join(__dirname, '달걀도둑3D.html');
const MAX = 5;
const PEN_ORDER = [2, 1, 3, 0, 4];   // 가운데 우리부터 채움

// ---------- 게임 페이지 ----------
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    fs.readFile(GAME, (err, data) => {
      if (err) { res.writeHead(500); res.end('달걀도둑3D.html 파일을 찾을 수 없어요'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } else { res.writeHead(404); res.end(); }
});

// ---------- WebSocket (RFC 6455, 텍스트 메시지만) ----------
function frame(text) {
  const body = Buffer.from(text);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n])
    : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  return Buffer.concat([head, body]);
}
function control(op, payload = Buffer.alloc(0)) { return Buffer.concat([Buffer.from([0x80 | op, payload.length]), payload]); }

server.on('upgrade', (req, sock) => {
  if (!req.url.startsWith('/ws') || req.headers.upgrade?.toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);

  const client = { sock, id: null, alive: true, send: m => { if (!sock.destroyed) sock.write(frame(JSON.stringify(m))); } };
  let buf = Buffer.alloc(0), parts = [];
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { sock.destroy(); return; }   // 1MB 넘는 메시지는 거부
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4); data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      }
      buf = buf.subarray(need);
      if (op === 0x8) { sock.end(control(0x8)); return; }
      if (op === 0x9) { sock.write(control(0xA, data)); continue; }
      if (op === 0xA) { client.alive = true; continue; }
      if (op === 0x1 || op === 0x0) {
        parts.push(data);
        if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; onMessage(client, text); }
      }
    }
  });
  sock.on('close', () => leave(client));
  sock.on('error', () => leave(client));
});

// ---------- 방 ----------
const players = new Map();   // id → { client, name, pen, st, slots }
const taken = new Map();     // "주기:단계:번호" → { c, lv, i }   (누가 가져간 둥지 달걀)
const grounds = new Map();   // id → gdrop 메시지                  (바닥에 내려놓은 달걀)
let newestCycle = 0, nextId = 1;

function broadcast(m, except) { for (const p of players.values()) if (p.client !== except) p.client.send(m); }
function seeCycle(c) {
  if (typeof c !== 'number' || c <= newestCycle) return;
  newestCycle = c;   // 아침이 오면 지난 날 달걀 기록은 지움
  for (const [k, v] of taken) if (v.c < c) taken.delete(k);
  for (const [k, v] of grounds) if (v.c < c) grounds.delete(k);
}

function onMessage(client, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;

  if (m.t === 'hello') {
    if (client.id) return;
    const used = new Set([...players.values()].map(p => p.pen));
    const pen = PEN_ORDER.find(k => !used.has(k));
    if (players.size >= MAX || pen === undefined) { client.send({ t: 'full' }); return; }
    const name = String(m.name || '플레이어').replace(/[\u0000-\u001f]/g, '').slice(0, 10) || '플레이어';
    client.id = 'p' + nextId++;
    const me = { client, name, pen, st: null, slots: [] };
    client.send({
      t: 'welcome', id: client.id, pen,
      players: [...players.entries()].map(([id, p]) => ({ id, name: p.name, pen: p.pen, st: p.st, slots: p.slots })),
      taken: [...taken.values()], grounds: [...grounds.values()],
    });
    players.set(client.id, me);
    broadcast({ t: 'join', id: client.id, name, pen }, client);
    console.log(`👋 ${name} 입장 (${pen + 1}번 우리) — ${players.size}/${MAX}명`);
    return;
  }

  const me = players.get(client.id);
  if (!me) return;
  // 바닥 달걀(gdrop/gtake)의 id는 달걀 id, 나머지 메시지의 id는 보낸 사람 id
  const ground = m.t === 'gdrop' || m.t === 'gtake';
  const out = ground ? m : Object.assign({}, m, { id: client.id });
  if (m.t === 'st') me.st = { x: m.x, y: m.y, z: m.z, f: m.f, h: m.h, w: m.w };
  else if (m.t === 'pen') me.slots = Array.isArray(m.slots) ? m.slots.slice(0, 18) : [];
  else if (m.t === 'take') { seeCycle(m.c); taken.set(`${m.c}:${m.lv}:${m.i}`, { c: m.c, lv: m.lv, i: m.i }); }
  else if (m.t === 'ret') { seeCycle(m.c); taken.delete(`${m.c}:${m.lv}:${m.i}`); }
  else if (m.t === 'gdrop') { seeCycle(m.c); grounds.set(m.id, m); }
  else if (m.t === 'gtake') grounds.delete(m.id);
  else return;
  broadcast(out, client);
}

function leave(client) {
  if (!client.id || !players.has(client.id)) return;
  const me = players.get(client.id);
  players.delete(client.id);
  broadcast({ t: 'leave', id: client.id });
  console.log(`👋 ${me.name} 퇴장 — ${players.size}/${MAX}명`);
}

// 응답 없는 연결 정리 (30초마다 ping)
setInterval(() => {
  for (const p of players.values()) {
    const c = p.client;
    if (!c.alive) { c.sock.destroy(); leave(c); continue; }
    c.alive = false; c.sock.write(control(0x9));
  }
}, 30000);

server.listen(PORT, () => {
  console.log('🥚 달걀 도둑 3D 서버가 켜졌어요!');
  console.log(`   이 컴퓨터에서:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`   같은 와이파이: http://${a.address}:${PORT}`);
  console.log('   (끄려면 Ctrl + C)');
});
