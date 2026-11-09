import assert from 'node:assert/strict';
import net from 'node:net';
import { FakeRedisClient } from './fake-redis.js';

// Capture the real Redis client's RESP commands, including all EVAL arguments,
// across every connection. Only the server's data/script execution is a fake.
// No real Redis, provider, account, or installed runtime is used.
export async function recordingRedisServer(t) {
  const database = new FakeRedisClient();
  const commands = [], errors = [], sockets = new Set();
  const bulk = value => value === null ? '$-1\r\n'
    : `$${Buffer.byteLength(String(value))}\r\n${value}\r\n`;
  const reply = value => value instanceof Map
    ? `%${value.size}\r\n${[...value].flatMap(pair => pair.map(reply)).join('')}`
    : Array.isArray(value)
    ? `*${value.length}\r\n${value.map(reply).join('')}`
    : typeof value === 'number' ? `:${value}\r\n` : bulk(value);
  async function execute([name, ...args]) {
    switch (name.toUpperCase()) {
      case 'HELLO': return new Map([['server', 'redis'], ['version', '7.2.0'], ['proto', 3],
        ['id', 1], ['mode', 'standalone'], ['role', 'master'], ['modules', []]]);
      case 'CLIENT': return 'OK';
      case 'QUIT': return 'OK';
      case 'GET': return database.get(args[0]);
      case 'SMEMBERS': return database.sMembers(args[0]);
      case 'MGET': return database.mGet(args);
      case 'EVAL': {
        const count = Number(args[1]);
        return database.eval(args[0], { keys: args.slice(2, 2 + count), arguments: args.slice(2 + count) });
      }
      default: throw new Error(`Unexpected Redis command: ${name}`);
    }
  }
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => errors.push(error));
    let pending = Buffer.alloc(0), queue = Promise.resolve();
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      try {
        while (pending.length) {
          const headerEnd = pending.indexOf('\r\n');
          if (headerEnd < 0) return;
          assert.equal(pending[0], 42, 'RESP command must be an array');
          const count = Number(pending.subarray(1, headerEnd));
          assert.ok(Number.isSafeInteger(count) && count > 0);
          let offset = headerEnd + 2;
          const command = [];
          for (let i = 0; i < count; i++) {
            const end = pending.indexOf('\r\n', offset);
            if (end < 0) return;
            assert.equal(pending[offset], 36, 'RESP argument must be a bulk string');
            const size = Number(pending.subarray(offset + 1, end));
            assert.ok(Number.isSafeInteger(size) && size >= 0);
            if (pending.length < end + 2 + size + 2) return;
            command.push(pending.subarray(end + 2, end + 2 + size).toString('utf8'));
            offset = end + 2 + size + 2;
          }
          pending = pending.subarray(offset);
          commands.push(command);
          queue = queue.then(async () => {
            try {
              socket.write(reply(await execute(command)));
              if (command[0].toUpperCase() === 'QUIT') socket.end();
            } catch (error) {
              errors.push(error);
              t.diagnostic(error.message);
              socket.write('-ERR unsupported fixture operation\r\n');
            }
          });
        }
      } catch (error) { errors.push(error); socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, [], 'all Redis commands must be handled successfully');
  });
  return { database, commands, url: `redis://127.0.0.1:${server.address().port}` };
}

export function assertNoRedisSecrets(commands, secrets) {
  for (const [index, command] of commands.entries()) {
    for (const value of command) {
      for (const secret of secrets) {
        assert.ok(!value.includes(secret), `stand-in credential reached Redis command ${index} (${command[0]})`);
      }
    }
  }
}
