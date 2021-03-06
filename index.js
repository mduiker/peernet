var inherits = require('inherits');
var has = require('has');
var defined = require('defined');
var isarray = require('isarray');
var once = require('once');
var onend = require('end-of-stream');

var sprintf = require('sprintf');
var concatMap = require('concat-map');
var shuffle = require('shuffle-array');

var through = require('through2');
var readonly = require('read-only-stream');
var lenpre = require('length-prefixed-stream');
var xtend = require('xtend');

var EventEmitter = require('events').EventEmitter;
var getBrowserRTC = require('get-browser-rtc');

var crypto = require('crypto');
function sha (buf) {
    return crypto.createHash('sha512').update(buf).digest();
}

var Peer = require('./lib/peer.js');
var randomPeers = require('./lib/random.js');
var wrtc = require('./lib/wrtc.js');

module.exports = Peernet;
inherits(Peernet, EventEmitter);

function Peernet (db, opts) {
    if (!(this instanceof Peernet)) return new Peernet(db, opts);
    var self = this;
    EventEmitter.call(this);
    this.db = db;
    this._options = opts;
    this._id = crypto.randomBytes(16);
    this._hexid = this._id.toString('hex');
    this._transport = opts.transport;
    this._streams = {}; // keyed by id
    this._peers = {}; // map id to Peer instance
    this._connections = {}; // keyed by addr
    this._aliases = {}; // maps id to an array of addrs
    
    this._recent = { request: {}, response: {} };
    this._origin = {};
    this._originQueue = [];
    this._intervals = [];
    this._wrtc = opts.wrtc === false
        ? undefined
        : getBrowserRTC() || opts.wrtc
    ;
    
    var ivms = defined(opts.interval, 5000);
    var ivsize = defined(opts.size, 10);
    if (ivms) this._getNodesLoop(ivms, ivsize);
    
    if (opts.bootstrap !== false) {
        this.bootstrap(opts);
    }
};

Peernet.prototype.bootstrap = function (opts) {
    var self = this;
    var pending = 0;
    var n = defined(opts.connections, 5);
    var ivms = defined(opts.interval, 5000);
    var purgems = defined(opts.purge, 60 * 1000);
    
    this._intervals.push(setInterval(function () {
        var needed = n - pending - self.connections().length;
        if (needed === 0) return;
        if (self.connections().length > 0 && self._wrtc
        && Math.random() > 0.5) {
            pending ++;
            self.peer('webrtc', function (err, peer, addrs) {
                pending --;
            });
        }
        else randomPeers(self.db, needed).pipe(through.obj(write));
    }, ivms));
    
    if (purgems) {
        this._intervals.push(setInterval(function () {
            self._purge(10);
        }, purgems));
    }
    
    function write (row, enc, next) {
        var addr = row.value;
        if (has(self._connections, addr)) return next();
        if (has(self._aliases, addr)) return next();
        
        pending ++;
        self.connect(addr, function (err) {
            pending --;
        });
        next();
    }
};

Peernet.prototype.close = function () {
    var self = this;
    self._intervals.forEach(function (iv) {
        clearInterval(iv);
    });
    self.connections().forEach(function (addr) {
        self.disconnect(addr);
    });
    Object.keys(self._streams).forEach(function (id) {
        var stream = self._streams[id];
        if (stream.destroy) stream.destroy()
        else stream.end()
    });
};

Peernet.prototype._getNodesLoop = function (ms, size) {
    var self = this;
    self.on('peer', function (peer) {
        var disconnected = false;
        var timeout = null;
        
        peer.once('disconnect', function () {
            disconnected = true;
            clearTimeout(timeout);
        });
        getNodes(peer, function f () {
            if (disconnected) return;
            timeout = setTimeout(function () {
                if (disconnected) return;
                getNodes(peer, f);
            }, ms);
        });
    });
    
    function getNodes (peer, cb) {
        var nodes = [];
        var pending = 1;
        peer.getNodes({ size: size }).pipe(through.obj(write, end));
        
        function write (node, enc, next) {
            self._debug('node reply: %s', node.data.toString());
            pending ++;
            
            self.db.get('rm!' + node.data.toString(), function (err, d) {
                // ignore "recently" removed nodes (in the past day)
                if (!err && Date.now() - d < 1000 * 60 * 60 * 24) {
                    self._debug('skipping previously removed node %s',
                        node.data.toString()
                    );
                }
                else nodes.push(node.data.toString());
                if (-- pending === 0) done();
            })
            next();
        }
        function end (next) {
            if (-- pending === 0) done();
            next();
        }
        function done () {
            self.save(nodes, function (err) {
                if (err) self.emit('error', err);
                cb();
            });
        }
    }
};

Peernet.prototype._debug = function () {
    var msg = sprintf.apply(null, arguments);
    if (this._options.debug) {
        console.error(msg);
    }
    this.emit('debug', msg);
};

Peernet.prototype.connect = function (addr, cb) {
    cb = once(cb || function () {});
    var self = this;
    addr = addr.toString();
    var c = this._transport(addr);
    self._connections[addr] = c;
    
    var peer = this.createStream();
    peer.on('destroy', function () {
        if (c.destroy) c.destroy()
    });
    
    peer.on('id', function (id) {
        if (has(self._streams, id)) {
            if (!self._aliases[addr]) self._aliases[addr] = [];
            if (self._aliases[addr].indexOf(id) < 0) {
                self._aliases[addr].push(id);
            }
            c.destroy();
        }
    });
    c.pipe(peer).pipe(c);
    
    c.once('error', cb);
    onend(c, function () {
        if (c.destroy) c.destroy();
        delete self._connections[addr];
    });
    
    c.once('connect', function () {
        self._debug('connected: %s', addr);
        self.emit('connect', peer);
        peer.emit('connect');
        cb(null);
    });
    return peer;
};

Peernet.prototype.peer = function (proto, cb) {
    var self = this;
    if ((proto === 'wrtc' || proto === 'webrtc') && self._wrtc) {
        wrtc(self, self._wrtc, function (err, con) {
            if (err) return cb(err);
            var peer = self.createStream();
            var peerId = null;
            peer.on('id', function (id) {
                peerId = id;
                self._debug('connected: %s', peerId);
            });
            con.pipe(peer).pipe(con);
            
            onend(con, function () {
                self.emit('disconnect', peer);
                self._debug('disconnected %s', String(peerId));
                peer.emit('disconnect');
            });
            
            self.emit('connect', peer);
            cb(err, con);
        });
    }
    else throw new Error('unrecognized protocol');
};

Peernet.prototype.known = function (opts) {
    if (!opts) opts = {};
    var r = this.db.createReadStream({
        gt: 'addr!' + defined(opts.gt, ''),
        lt: 'addr!' + defined(opts.lt, '~'),
        limit: opts.limit,
        valueEncoding: 'binary'
    });
    var out = readonly(r.pipe(through.obj(function (row, enc, next) {
        this.push(row.value);
        next();
    })).pipe(lenpre.encode()));
    r.on('error', function (err) { out.emit('error', err) });
    return out;
};

Peernet.prototype.announce = function (opts) {
    var self = this;
    var output = through.obj();
    Object.keys(self._peers).forEach(function (key) {
        var peer = self._peers[key];
        peer.announce(opts).pipe(output, { end: false });
    });
    return readonly(output);
};

Peernet.prototype.disconnect = function (addr) {
    if (has(this._connections, addr)) {
        this._connections[addr].destroy();
        delete this._connections[addr];
    }
};

Peernet.prototype.connections = function () {
    return Object.keys(this._connections);
};

Peernet.prototype.save = function (addrs, cb) {
    var self = this;
    if (!isarray(addrs)) addrs = [addrs];
    this.db.batch(concatMap(addrs, function (addr) {
        if (typeof node === 'string') addr = Buffer(addr);
        var key = sha(addr).toString('hex');
        return [
            {
                type: 'put',
                key: 'addr!' + key,
                value: addr
            }
        ];
    }), { valueEncoding: 'binary' }, cb);
    
    addrs.forEach(function (node) {
        self.emit('known', node);
    });
};

Peernet.prototype.remove = function (nodes, cb) {
    var self = this;
    cb = once(cb || function () {});
    var keys = [], rms = [];
    var db = this.db;
    var pending = 1;
    
    nodes.forEach(function (node) {
        var key = sha(node.address).toString('hex');
        keys.push('addr!' + key);
        rms.push({ type: 'put', key: 'rm!' + key, value: Date.now() });
        pending += 2;
        
        var x = db.createReadStream({
            gt: 'stats!' + key + '!',
            lt: 'stats!' + key + '!~'
        });
        x.on('error', cb);
        x.pipe(through.obj(function (row, enc, next) {
            keys.push(row.key);
            next();
        }, done));
        
        var y = db.createReadStream({
            gt: 'con!' + key + '!',
            lt: 'con!' + key + '!~'
        });
        y.on('error', cb);
        y.pipe(through.obj(function (row, enc, next) {
            keys.push(row.key);
            next();
        }, done));
    });
    done();
    
    function done () {
        if (-- pending !== 0) return;
        var ops = keys.map(function (key) {
            return { type: 'del', key: key };
        }).concat(rms);
        db.batch(ops, function (err) {
            if (err) return cb(err);
            self._debug('removed %d nodes', keys.length);
            cb(null);
        });
    }
};

Peernet.prototype._logStats = function (addr, stats, cb) {
    var key = sha(addr).toString('hex');
    this.db.batch([
        {
            type: 'put',
            key: 'stats!' + key + '!' + new Date().toISOString(),
            value: JSON.stringify(stats)
        }
    ], cb);
};

Peernet.prototype._logConnection = function (addr, stats, cb) {
    var key = sha(addr).toString('hex');
    this.db.batch([
        {
            type: 'put',
            key: 'con!' + key + '!' + new Date().toISOString(),
            value: JSON.stringify(stats)
        }
    ], cb);
};

Peernet.prototype._purge = function (n, cb) {
    var self = this;
    if (n === undefined) n = 50;
    var remove = [];
    var pending = 1;
    randomPeers(self.db, n).pipe(through.obj(write, end));
    
    function write (row, enc, next) {
        var addr = row.value.toString();
        pending ++;
        self.getStats(addr, function (err, stats) {
            if (err) return;
            var ok = stats.connections.ok;
            var fail = stats.connections.fail;
            var ratio = ok / (fail + ok);
            if (fail + ok > 0 && (ok === 0 || ratio < 0.2)) {
                remove.push({ address: addr });
            }
            if (--pending === 0) done();
        });
        next();
    }
    function end () { if (-- pending === 0) done() }
    function done () {
        if (remove.length) self.remove(remove, cb)
        else if (cb) cb(null)
    }
};

Peernet.prototype.getStats = function (addr, cb) {
    var key = sha(addr).toString('hex');
    var pending = 2;
    cb = once(cb || function () {});
    
    var stats = {
        connections: { ok: 0, fail: 0 },
        nodes: { rx: 0, tx: 0 }
    };
    var s = this.db.createReadStream({
        gt: 'stats!' + addr,
        lt: 'stats!' + addr + '!~'
    });
    s.once('error', cb);
    s.pipe(through.obj(swrite, done));
    
    var c = this.db.createReadStream({
        gt: 'con!' + key + '!',
        lt: 'con!' + key + '!~'
    });
    c.once('error', cb);
    c.pipe(through.obj(cwrite, done));
    
    function swrite (row, enc, next) {
        try { var value = JSON.parse(row.value) }
        catch (err) { return this.emit('error', err) }
        stats.nodes.rx += Number(value.rx) || 0;
        stats.nodes.tx += Number(value.tx) || 0;
        next();
    }
    function cwrite (row, enc, next) {
        try { var value = JSON.parse(row.value) }
        catch (err) { return this.emit('error', err) }
        stats.connections.ok += value.ok ? 1 : 0;
        stats.connections.fail += value.ok ? 0 : 1;
        next();
    }
    
    function done () {
        if (-- pending !== 0) return;
        cb(null, stats);
    }
};

Peernet.prototype.createStream = function () {
    var self = this;
    var peer = new Peer(self.db, self._id, {
        recent: self._recent
    });
    var hello = false;
    var peerId = null;
    
    // ------------------------------------
    peer.on('id', function (id) {
        if (has(self._streams, id)) {
            if (!self._aliases[addr]) self._aliases[addr] = [];
            if (self._aliases[addr].indexOf(id) < 0) {
                self._aliases[addr].push(id);
            }
            c.destroy();
        }
        peerId = id;
        self._peers[id] = peer;
    });
    
    peer.hello(function (err, id) {
        peerId = id.toString('hex');
        self._debug('HELLO %s', peerId);
        peer.emit('id', peerId);
        
        if (self._hexid === peerId) {
            // we've connected to ourself!
            self._debug('connected to own service');
            return peer.emit('destroy');
        }
        if (has(self._streams, peerId)) {
            // already connected to this peer
            self._debug('already connected to id: %s', peerId);
            return peer.emit('destroy');
        }
        hello = true;
        self._streams[peerId] = peer;
        self._originQueue.splice(0).forEach(function (f) {
            f(peerId);
        });
        peer.emit('ok');
    });
    onend(peer, onclose);
    
    peer.on('debug', function () {
        self._debug.apply(self, arguments);
    });
    peer.on('request', function (req) {
        self.emit('request', req);
        if (req.type) self.emit('request:' + req.type, req);
        
        if (peerId) onrequest(req, peerId)
        else self._originQueue.push(function (id) { onrequest(req, id) });
    });
    
    function onrequest (req, id) {
        self._origin[req.id.toString('hex')] = id;
        var keys = Object.keys(self._peers).filter(function (key) {
            return key !== id;
        });
        var nreq = xtend(req, { hops: req.hops + 1 });
        shuffle(keys).slice(0,3).forEach(function (key) {
            self._peers[key].announce(nreq).pipe(through.obj(
                function (row, enc, next) {
                    req.reply(row);
                    next();
                }
            ));
        });
    }
    
    peer.on('response', function (res) {
        self.emit('response', res);
        if (res.type) self.emit('response:' + res.type, res);
        
        var hexid = res.reply && res.reply.toString('hex');
        if (hexid && has(self._origin, hexid)
        && has(self._peers, self._origin[hexid])) {
            self._peers[self._origin[hexid]]._pushMessage({
                response: xtend(res, {
                    hops: res.hops + 1
                })
            });
        }
        else {
            var keys = Object.keys(self._peers).filter(function (key) {
                return key !== peerId;
            });
            var nres = xtend(res, { hops: res.hops + 1 });
            shuffle(keys).slice(0,3).forEach(function (key) {
                self._peers[key]._pushMessage({
                    response: nres
                });
            });
        }
    });
    peer.on('error', function (err) {
        self.emit('error', err)
    });
    
    self.emit('peer', peer);
    return peer;
    
    function onclose () {
        if (!hello) peer.emit('failed')
        delete self._streams[peerId];
        delete self._peers[peerId];
        self._debug('disconnected: %s', peerId);
        self.emit('disconnect', peer);
        peer.emit('disconnect');
    }
};
