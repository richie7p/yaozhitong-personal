/* Task-local Node guard: allow loopback/IPC, reject remote runtime connections. */
const fs = require('node:fs');
const net = require('node:net');
const log = process.env.YZT_BATCH2_NETWORK_LOG;
const local = host => {
  const value = String(host || 'localhost').toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);
};
function deny(kind, host) {
  if (log) fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, host: String(host) }) + '\n');
  const error = new Error('BATCH2_REMOTE_RUNTIME_NETWORK_DENIED:' + kind + ':' + host);
  error.code = 'YZT_RUNTIME_NETWORK_DENIED';
  throw error;
}
function hostOf(value) {
  if (typeof value === 'string' || value instanceof URL) {
    try { return new URL(String(value)).hostname; } catch { return 'localhost'; }
  }
  return value?.hostname || (value?.host ? String(value.host).replace(/:\d+$/, '') : 'localhost');
}
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function (...args) {
      const host = hostOf(args[0]);
      if (!local(host)) deny(name + '.' + method, host);
      return original.apply(this, args);
    };
  }
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  if (options && typeof options === 'object' && options.path) return originalConnect.apply(this, args);
  if (typeof options === 'string' && !/^\d+$/.test(options)) return originalConnect.apply(this, args);
  const host = options && typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!local(host)) deny('net.Socket.connect', host);
  return originalConnect.apply(this, args);
};
const http2 = require('node:http2');
const connect2 = http2.connect;
http2.connect = function (...args) {
  const host = hostOf(args[0]);
  if (!local(host)) deny('http2.connect', host);
  return connect2.apply(this, args);
};
if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (input, ...args) {
    const host = hostOf(input && typeof input === 'object' && 'url' in input ? input.url : input);
    if (!local(host)) return Promise.reject((() => { try { deny('fetch', host); } catch (error) { return error; } })());
    return originalFetch.call(this, input, ...args);
  };
}
require('node:module').syncBuiltinESMExports();
