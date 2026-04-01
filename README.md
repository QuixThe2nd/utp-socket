# utp-socket

utp (micro transport protocol) implementation in node with [dgram socket](https://nodejs.org/api/dgram.html#dgram_class_dgram_socket) compatibility. To install with npm:

	npm install QuixThe2nd/utp-socket

## What is utp?

utp (micro transport protocol) is a network protocol similar to tcp that runs on top of udp.
Since it builds on top of udp it can provide great peer to peer connectivity
through techniques like hole punching and similar while still providing a stream interface.
It is currently the main network protocol powering bittorrent.

## What is utp-socket?

utp-socket is a fork of [utp](https://github.com/mafintosh/utp) that allows the same socket to be re-used by both both client and server.

## BEWARE BEWARE BEWARE

*This module is a work in progress! So beware of dragons!*

## Usage

utp has the same interface as the dgram module in node dgram with UTP stream connections on a single port.

``` js
import utp from 'utp'

var socket = utp()

socket.bind(10000, function () {
  console.log('bound to', socket.address())
})

// listen for incoming UTP connections
socket.on('connection', function (connection) {
  console.log('new connection from', connection.remoteAddress, connection.remotePort)
  connection.on('data', function (data) {
    console.log('client says ' + data)
  })
})

// connect to a remote UTP peer
var client = socket.connect(10000, '127.0.0.1')
client.write('hello world')

// send and receive raw UDP messages on the same socket
socket.send(Buffer.from('ping'), 0, 4, 10000, '127.0.0.1')

socket.on('message', function (buf, rinfo) {
  console.log('got raw udp message from', rinfo.address, rinfo.port)
})
```

## API

#### `var socket = utp([options])`

Create a new UTP socket. Options include:

- `allowHalfOpen` — keep streams open when one side ends (default: `true`)

#### `socket.bind(port, [host], [onlistening])`

Bind the underlying UDP socket. If not called explicitly, `connect()` and `send()` will auto-bind to a random port.

#### `socket.listen(port, [host], [onlistening])`

Bind and begin accepting incoming UTP connections. Equivalent to calling `bind()` if not already bound.

#### `socket.connect(port, host)`

Create an outbound UTP connection. Returns a duplex stream.

#### `socket.send(buf, offset, length, port, host, [callback])`

Send a raw UDP datagram, just like `dgram.send()`.

#### `socket.close([callback])`

Close all connections and the underlying socket.

#### `socket.address()`

Returns `{ address, port }` of the bound socket.

#### `socket.ref()` / `socket.unref()`

Ref or unref the underlying UDP socket for the event loop.

### Events

- `listening` — socket is bound
- `connection(stream)` — incoming UTP connection
- `message(buffer, rinfo)` — raw (non-UTP) UDP message received
- `error(err)` — socket error
- `close` — socket closed

### Connection

Connections are duplex streams with the following additions:

- `connection.remoteAddress` — remote IP
- `connection.remotePort` — remote port
- `connection.address()` — returns `{ address, port }`
- `connection.setContentSize(size)` — hint at total content size
- `connection.setInteractive(bool)` — hint for latency-sensitive mode
- `connection.setTimeout(ms, [ontimeout])` — set an idle timeout

## License

MIT
