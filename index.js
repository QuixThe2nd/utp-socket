var dgram = require('dgram');
var cyclist = require('cyclist');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Duplex = require('stream').Duplex;
var bufferAlloc = require('buffer-alloc');

var EXTENSION = 0;
var VERSION   = 1;
var UINT16    = 0xffff;
var ID_MASK   = 0xf << 4;
var MTU       = 1400;

var PACKET_DATA  = 0 << 4;
var PACKET_FIN   = 1 << 4;
var PACKET_STATE = 2 << 4;
var PACKET_RESET = 3 << 4;
var PACKET_SYN   = 4 << 4;

var MIN_PACKET_SIZE = 20;
var DEFAULT_WINDOW_SIZE = 1 << 18;
var CLOSE_GRACE = 5000;

var BUFFER_SIZE = 512;

var uint32 = function(n) {
	return n >>> 0;
};

var uint16 = function(n) {
	return n & UINT16;
};

var timestamp = function() {
	var offset = process.hrtime();
	var then = Date.now() * 1000;

	return function() {
		var diff = process.hrtime(offset);
		return uint32(then + 1000000 * diff[0] + ((diff[1] / 1000) | 0));
	};
}();

var bufferToPacket = function(buffer) {
	var packet = {};
	packet.id = buffer[0] & ID_MASK;
	packet.connection = buffer.readUInt16BE(2);
	packet.timestamp = buffer.readUInt32BE(4);
	packet.timediff = buffer.readUInt32BE(8);
	packet.window = buffer.readUInt32BE(12);
	packet.seq = buffer.readUInt16BE(16);
	packet.ack = buffer.readUInt16BE(18);
	packet.data = buffer.length > 20 ? buffer.slice(20) : null;
	return packet;
};

var packetToBuffer = function(packet) {
	var buffer = bufferAlloc(20 + (packet.data ? packet.data.length : 0));
	buffer[0] = packet.id | VERSION;
	buffer[1] = EXTENSION;
	buffer.writeUInt16BE(packet.connection, 2);
	buffer.writeUInt32BE(packet.timestamp, 4);
	buffer.writeUInt32BE(packet.timediff, 8);
	buffer.writeUInt32BE(packet.window, 12);
	buffer.writeUInt16BE(packet.seq, 16);
	buffer.writeUInt16BE(packet.ack, 18);
	if (packet.data) packet.data.copy(buffer, 20);
	return buffer;
};

var isUTPPacket = function(buffer) {
	if (buffer.length < MIN_PACKET_SIZE) return false;
	var id = buffer[0] & ID_MASK;
	var ver = buffer[0] & 0x0f;
	return ver === VERSION && (id === PACKET_DATA || id === PACKET_FIN || id === PACKET_STATE || id === PACKET_RESET || id === PACKET_SYN);
};

var createPacket = function(connection, id, data) {
	return {
		id: id,
		connection: id === PACKET_SYN ? connection._recvId : connection._sendId,
		seq: connection._seq,
		ack: connection._ack,
		timestamp: timestamp(),
		timediff: 0,
		window: DEFAULT_WINDOW_SIZE,
		data: data,
		sent: 0
	};
};

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

var Connection = function(port, host, socket, syn, allowHalfOpen) {
	Duplex.call(this, { allowHalfOpen: allowHalfOpen !== false });
	var self = this;

	this.remotePort = port;
	this.remoteAddress = host;
	this.port = port;
	this.host = host;
	this.socket = socket;

	this._outgoing = cyclist(BUFFER_SIZE);
	this._incoming = cyclist(BUFFER_SIZE);
	this._closed = false;
	this._contentSize = 0;
	this._interactive = false;

	this._inflightPackets = 0;
	this._closed = false;
	this._alive = false;

	if (syn) {
		this._connecting = false;
		this._recvId = uint16(syn.connection+1);
		this._sendId = syn.connection;
		this._seq = (Math.random() * UINT16) | 0;
		this._ack = syn.seq;
		this._synack = createPacket(this, PACKET_STATE, null);

		this._transmit(this._synack);
	} else {
		this._connecting = true;
		this._recvId = 0;
		this._sendId = 0;
		this._seq = (Math.random() * UINT16) | 0;
		this._ack = 0;
		this._synack = null;

		// For standalone client connections that own their own socket,
		// we set up the recv id from the bound port.
		// For connections created through UTPSocket.connect(), the
		// caller sets _recvId/_sendId before calling _connect().
	}

	var resend = setInterval(this._resend.bind(this), 500);
	var keepAlive = setInterval(this._keepAlive.bind(this), 10*1000);
	var tick = 0;

	var closed = function() {
		if (++tick === 2) self._closing();
	};

	var sendFin = function() {
		if (self._connecting) return self.once('connect', sendFin);
		self._sendOutgoing(createPacket(self, PACKET_FIN, null));
		self.once('flush', closed);
	};

	this.once('finish', sendFin);
	this.once('close', function() {
		clearInterval(resend);
		clearInterval(keepAlive);
	});
	this.once('end', function() {
		process.nextTick(closed);
	});
};

util.inherits(Connection, Duplex);

Connection.prototype.setContentSize = function(size) {
	this._contentSize = size;
};

Connection.prototype.setInteractive = function(interactive) {
	this._interactive = interactive;
};

Connection.prototype.setTimeout = function(ms, ontimeout) {
	// TODO: implement timeout
	if (ontimeout) this.once('timeout', ontimeout);
};

Connection.prototype.destroy = function() {
	this.end();
};

Connection.prototype.address = function() {
	return { port: this.port, address: this.host };
};

Connection.prototype._read = function() {
	// do nothing...
};

Connection.prototype._write = function(data, enc, callback) {
	if (this._connecting) return this._writeOnce('connect', data, enc, callback);

	while (this._writable()) {
		var payload = this._payload(data);

		this._sendOutgoing(createPacket(this, PACKET_DATA, payload));

		if (payload.length === data.length) return callback();
		data = data.slice(payload.length);
	}

	this._writeOnce('flush', data, enc, callback);
};

Connection.prototype._writeOnce = function(event, data, enc, callback) {
	this.once(event, function() {
		this._write(data, enc, callback);
	});
};

Connection.prototype._writable = function() {
	return this._inflightPackets < BUFFER_SIZE-1;
};

Connection.prototype._payload = function(data) {
	if (data.length > MTU) return data.slice(0, MTU);
	return data;
};

Connection.prototype._resend = function() {
	var offset = this._seq - this._inflightPackets;
	var first = this._outgoing.get(offset);
	if (!first) return;

	var timeout = 500000;
	var now = timestamp();

	if (uint32(first.sent - now) < timeout) return;

	for (var i = 0; i < this._inflightPackets; i++) {
		var packet = this._outgoing.get(offset+i);
		if (uint32(packet.sent - now) >= timeout) this._transmit(packet);
	}
};

Connection.prototype._keepAlive = function() {
	if (this._alive) return this._alive = false;
	this._sendAck();
};

Connection.prototype._closing = function() {
	if (this._closed) return;
	this._closed = true;
	process.nextTick(this.emit.bind(this, 'close'));
};

// packet handling

Connection.prototype._recvAck = function(ack) {
	var offset = this._seq - this._inflightPackets;
	var acked = uint16(ack - offset)+1;

	if (acked >= BUFFER_SIZE) return;

	for (var i = 0; i < acked; i++) {
		this._outgoing.del(offset+i);
		this._inflightPackets--;
	}

	if (!this._inflightPackets) this.emit('flush');
};

Connection.prototype._recvIncoming = function(packet) {
	if (this._closed) return;

	if (packet.id === PACKET_SYN && this._connecting) {
		this._transmit(this._synack);
		return;
	}
	if (packet.id === PACKET_RESET) {
		this.push(null);
		this.end();
		this._closing();
		return;
	}
	if (this._connecting) {
		if (packet.id !== PACKET_STATE) return this._incoming.put(packet.seq, packet);

		this._ack = uint16(packet.seq-1);
		this._recvAck(packet.ack);
		this._connecting = false;
		this.emit('connect');

		packet = this._incoming.del(packet.seq);
		if (!packet) return;
	}

	if (uint16(packet.seq - this._ack) >= BUFFER_SIZE) return this._sendAck();

	this._recvAck(packet.ack);

	if (packet.id === PACKET_STATE) return;
	this._incoming.put(packet.seq, packet);

	while (packet = this._incoming.del(this._ack+1)) {
		this._ack = uint16(this._ack+1);

		if (packet.id === PACKET_DATA) this.push(packet.data);
		if (packet.id === PACKET_FIN)  this.push(null);
	}

	this._sendAck();
};

Connection.prototype._sendAck = function() {
	this._transmit(createPacket(this, PACKET_STATE, null));
};

Connection.prototype._sendOutgoing = function(packet) {
	this._outgoing.put(packet.seq, packet);
	this._seq = uint16(this._seq + 1);
	this._inflightPackets++;
	this._transmit(packet);
};

Connection.prototype._transmit = function(packet) {
	packet.sent = packet.sent === 0 ? packet.timestamp : timestamp();
	var message = packetToBuffer(packet);
	this._alive = true;
	this.socket.send(message, 0, message.length, this.port, this.host);
};

// ---------------------------------------------------------------------------
// UTPSocket — unified dgram-compatible API
// ---------------------------------------------------------------------------

var UTPSocket = function(opts) {
	if (!(this instanceof UTPSocket)) return new UTPSocket(opts);
	EventEmitter.call(this);

	this._socket = null;
	this._connections = {};
	this._bound = false;
	this._closed = false;
	this._closing = false;
	this._refed = true;
	this._allowHalfOpen = !opts || opts.allowHalfOpen !== false;
};

util.inherits(UTPSocket, EventEmitter);

UTPSocket.prototype._ensureSocket = function() {
	if (this._socket) return;
	this._socket = dgram.createSocket('udp4');
	this._attachSocket();
};

UTPSocket.prototype._attachSocket = function() {
	var self = this;
	var connections = this._connections;

	this._socket.on('message', function(message, rinfo) {
		// Try to route as UTP
		if (isUTPPacket(message)) {
			var packet = bufferToPacket(message);
			var id = rinfo.address + ':' + (packet.id === PACKET_SYN ? uint16(packet.connection+1) : packet.connection);

			if (connections[id]) {
				connections[id]._recvIncoming(packet);
				return;
			}

			if (packet.id === PACKET_SYN && !self._closed) {
				var conn = new Connection(rinfo.port, rinfo.address, self._socket, packet, self._allowHalfOpen);
				connections[id] = conn;
				conn.on('close', function() {
					delete connections[id];
					if (self._closing) self._closeMaybe();
				});
				self.emit('connection', conn);
				return;
			}
		}

		// Not a UTP packet (or unroutable) — emit as raw datagram
		self.emit('message', message, { address: rinfo.address, port: rinfo.port });
	});

	this._socket.on('error', function(err) {
		self.emit('error', err);
	});

	this._socket.on('close', function() {
		self.emit('close');
	});
};

UTPSocket.prototype.address = function() {
	if (!this._socket || !this._bound) throw new Error('Socket not bound');
	var addr = this._socket.address();
	return { address: addr.address, port: addr.port };
};

UTPSocket.prototype.bind = function(port, host, onlistening) {
	if (typeof port === 'function') return this.bind(0, null, port);
	if (typeof host === 'function') return this.bind(port, null, host);
	if (!port) port = 0;

	var self = this;

	this._ensureSocket();

	if (onlistening) this.once('listening', onlistening);

	this._socket.once('listening', function() {
		self._bound = true;
		self.emit('listening');
	});

	if (host) {
		this._socket.bind(port, host);
	} else {
		this._socket.bind(port);
	}
};

UTPSocket.prototype.listen = function(port, host, onlistening) {
	if (!this._bound) this.bind(port, host, onlistening);
	else if (onlistening) process.nextTick(onlistening);
};

UTPSocket.prototype.connect = function(port, host) {
	if (!host) host = '127.0.0.1';
	if (!this._bound) this.bind(0);

	var self = this;
	var conn = new Connection(port, host, null, null, this._allowHalfOpen);

	// We need to wait until the socket is bound so we can derive connection ids
	// from the local port, then wire the connection to use our shared socket.
	function setupConnection() {
		var localPort = self._socket.address().port;
		conn._recvId = localPort;
		conn._sendId = uint16(localPort + 1);
		conn.socket = self._socket;

		// Register so incoming packets route to this connection
		var id = host + ':' + conn._recvId;
		self._connections[id] = conn;
		conn.on('close', function() {
			delete self._connections[id];
			if (self._closing) self._closeMaybe();
		});

		conn._sendOutgoing(createPacket(conn, PACKET_SYN, null));
	}

	if (this._bound) {
		process.nextTick(setupConnection);
	} else {
		this.once('listening', setupConnection);
	}

	return conn;
};

UTPSocket.prototype.send = function(buf, offset, len, port, host, callback) {
	if (!callback) callback = noop;
	if (!this._bound) this.bind(0);

	var self = this;

	function doSend() {
		if (self._closed || self._closing) {
			return process.nextTick(callback, new Error('Socket is closed'));
		}
		self._socket.send(buf, offset, len, port, host, callback);
	}

	if (this._bound) {
		doSend();
	} else {
		this.once('listening', doSend);
	}
};

UTPSocket.prototype.close = function(cb) {
	if (this._closed) {
		if (cb) process.nextTick(cb);
		return;
	}
	if (cb) this.once('close', cb);
	this._closing = true;
	this._closeMaybe();
};

UTPSocket.prototype._closeMaybe = function() {
	if (!this._closing) return;

	var hasOpen = false;
	for (var id in this._connections) {
		if (!this._connections[id]._closed) {
			hasOpen = true;
			this._connections[id].end();
		}
	}

	if (!hasOpen) {
		this._closed = true;
		this._closing = false;
		if (this._socket) {
			this._socket.close();
		} else {
			var self = this;
			process.nextTick(function() { self.emit('close'); });
		}
	}
};

UTPSocket.prototype.ref = function() {
	this._refed = true;
	if (this._socket) this._socket.ref();
};

UTPSocket.prototype.unref = function() {
	this._refed = false;
	if (this._socket) this._socket.unref();
};

// ---------------------------------------------------------------------------
// Module export — factory function
// ---------------------------------------------------------------------------

function noop() {}

function utp(opts) {
	return new UTPSocket(opts);
}

module.exports = utp;
