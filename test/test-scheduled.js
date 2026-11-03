// Strict ES5. Deterministic power transitions, delays and durable wake claims.
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var scheduled = require('../server/lib/scheduled');
var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'glasshouse-scheduled-')) : path.join(os.tmpdir(), 'glasshouse-scheduled-' + process.pid);
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
var originalChmod = fs.chmodSync;
// Windows does not implement Unix private file modes; timing and writes are real.
if (process.platform === 'win32') fs.chmodSync = function () {};
var seq = 0;

function setup(options) {
  options = options || {};
  var time = 0, listener, queue = [], launches = [], reason = options.reason || 'onTimer';
  var powered = true;
  var stateFile = options.file || path.join(dir, 'state-' + (++seq) + '.json');
  var config = { allowControl: true, scheduledApps: options.settings || {
    enabled: true, actions: [{ appId: 'app.late', delaySeconds: 30 }, { appId: 'app.first', delaySeconds: 10 }]
  } };
  var elapsed = options.elapsed || 2;
  var boot = options.boot || 'boot-1';
  var uptime = 100;
  function delay(fn, ms) {
    var item = { at: time + ms, fn: fn, cancelled: false };
    queue.push(item);
    return function () { item.cancelled = true; };
  }
  scheduled.init({ config: config, stateFile: stateFile, bootId: boot,
    clock: function () { return time; }, now: function () { return 1700000000000 + time; }, later: delay,
    liveState: { state: {
      snapshot: function () { return { power: { systemOn: powered } }; },
      onChange: function (fn) { listener = fn; }
    } },
    luna: function (uri, data, cb) {
      if (uri.indexOf('getPowerOnReason') !== -1) return cb({ reason: reason, returnValue: true });
      if (uri.indexOf('getPowerOnTime') !== -1) return cb({ time: { uptime: String(uptime), ontime: String(elapsed) }, returnValue: true });
      cb({ returnValue: !options.missingApp });
    },
    control: function (action, id, cb) { launches.push({ id: id, at: time }); cb({ ok: !options.failLaunch }); }
  });
  function advance(ms) {
    var end = time + ms;
    while (true) {
      queue.sort(function (a, b) { return a.at - b.at; });
      var next = null;
      for (var i = 0; i < queue.length; i++) if (!queue[i].cancelled && queue[i].at <= end) { next = queue.splice(i, 1)[0]; break; }
      if (!next) break;
      time = next.at; next.fn();
    }
    time = end;
  }
  scheduled.start();
  return { config: config, launches: launches, file: stateFile, advance: advance,
    power: function (value, nextReason) { powered = value; if (nextReason) reason = nextReason; listener({ group: 'power', key: 'systemOn', value: value }); }
  };
}

try {
  assert.ok(scheduled.validate({ enabled: true, actions: [] }).error);
  assert.ok(scheduled.validate({ enabled: true, actions: [{ appId: 'bad;cmd', delaySeconds: 10 }] }).error);
  assert.ok(scheduled.validate({ enabled: true, actions: [{ appId: 'a', delaySeconds: 1 }] }).error);
  assert.ok(scheduled.validate({ enabled: true, actions: [{ appId: 'a', delaySeconds: 10 }, { appId: 'a', delaySeconds: 20 }] }).error);
  assert.ok(scheduled.validate({ enabled: false, actions: [] }).value);

  var tv = setup(); tv.advance(9000);
  assert.strictEqual(tv.launches.length, 0);
  tv.advance(1000);
  assert.strictEqual(tv.launches[0].id, 'app.first');
  tv.advance(21000);
  assert.deepEqual(tv.launches.map(function (x) { return x.id; }), ['app.first', 'app.late']);
  assert.strictEqual(scheduled.status().lastRun.state, 'completed');
  var doneFile = tv.file;
  tv = setup({ file: doneFile }); tv.advance(60000);
  assert.strictEqual(tv.launches.length, 0, 'restart on the same timer wake does not repeat a completed run');

  tv = setup({ reason: 'remoteKey' }); tv.advance(60000);
  assert.strictEqual(tv.launches.length, 0, 'ordinary power-on does not launch apps');
  tv = setup({ reason: 'onAoDByOnTimer' }); tv.advance(60000);
  assert.strictEqual(tv.launches.length, 0, 'Always Ready artwork timers are not On Timer');
  tv = setup({ elapsed: 181 }); tv.advance(60000);
  assert.strictEqual(tv.launches.length, 0, 'an old timer wake is not replayed after a late server start');

  tv = setup(); tv.advance(2000); tv.power(false); tv.advance(60000);
  assert.strictEqual(tv.launches.length, 0, 'power-off cancels pending launches');
  assert.strictEqual(scheduled.status().lastRun.state, 'cancelled');
  tv = setup(); tv.advance(2000); scheduled.apply({ enabled: false, actions: [] }); tv.advance(60000);
  assert.strictEqual(tv.launches.length, 0, 'editing/disabling a schedule cancels pending launches');
  tv = setup(); tv.advance(2000); tv.config.allowControl = false; tv.advance(60000);
  assert.strictEqual(tv.launches.length, 0, 'read-only mode is respected at execution time');

  tv = setup({ missingApp: true }); tv.advance(60000);
  assert.strictEqual(tv.launches.length, 0);
  assert.strictEqual(scheduled.status().lastRun.state, 'finished-with-errors');
  tv = setup({ failLaunch: true }); tv.advance(60000);
  assert.strictEqual(scheduled.status().lastRun.state, 'finished-with-errors');

  tv = setup(); tv.advance(2000);
  var pendingFile = tv.file;
  tv = setup({ file: pendingFile, elapsed: 5 }); tv.advance(60000);
  assert.strictEqual(tv.launches.length, 2, 'unstarted actions resume across a server restart');
  tv = setup({ file: doneFile, boot: 'boot-2' }); tv.advance(60000);
  assert.strictEqual(tv.launches.length, 2, 'a new cold boot is a distinct timer wake');
  console.log('Scheduled apps: validation, timer-only triggers, delay order, restart deduplication, recovery, cancellation and failures pass.');
} finally {
  fs.chmodSync = originalChmod;
  fs.readdirSync(dir).forEach(function (file) { fs.unlinkSync(path.join(dir, file)); });
  fs.rmdirSync(dir);
}
