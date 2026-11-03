var assert = require('assert');
var events = require('events');
var fs = require('fs');
var path = require('path');
var os = require('os');
var routes = require('../server/lib/routes');
var scheduled = require('../server/lib/scheduled');
var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'glasshouse-scheduled-routes-')) : path.join(os.tmpdir(), 'glasshouse-scheduled-routes-' + process.pid);
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
var file = path.join(dir, 'config.json');
var config = { token: 'unit-token', allowControl: true, scheduledApps: { enabled: false, actions: [] }, remoteDesktop: { enabled: true } };
fs.writeFileSync(file, JSON.stringify(config));
var oldMode = fs.chmodSync;
if (process.platform === 'win32') fs.chmodSync = function () {};
scheduled.init({ config: config, stateFile: path.join(dir, 'state.json'), bootId: 'test', liveState: null, luna: null, control: null });
routes.init({ config: config, configFile: file, scheduled: scheduled,
  telemetry: { getInstalledApps: function () { return [{ id: 'app.test', title: 'Test app' }]; } },
  luna: function (uri, body, cb) {
    assert.strictEqual(body.category, 'time');
    cb({ returnValue: true, settings: { onTimerEnable: 'on', onTimerHour: '7', onTimerMinute: '30', onTimerWeekday: '62' } });
  }
});
function request(method, payload, options) {
  options = options || {};
  var req = new events.EventEmitter(), result;
  req.method = method;
  req.url = '/api/scheduled' + (options.noToken ? '' : '?k=unit-token');
  req.connection = { remoteAddress: '192.0.2.2' };
  req.headers = { host: '192.0.2.1:8080', origin: options.origin || 'http://192.0.2.1:8080', 'content-type': options.type || 'application/json' };
  routes.handleRequest(req, { writeHead: function (code) { result = { code: code }; }, end: function (data) { result.body = JSON.parse(data); } });
  if (!result && method === 'POST') { req.emit('data', JSON.stringify(payload)); req.emit('end'); }
  return result;
}
try {
  assert.strictEqual(request('GET', null, { noToken: true }).code, 401);
  var info = request('GET');
  assert.strictEqual(info.code, 200);
  assert.deepEqual(info.body.timer.days, [1, 2, 3, 4, 5]);
  assert.strictEqual(info.body.timer.time, '07:30');
  assert.strictEqual(info.body.apps[0].title, 'Test app');
  var value = { enabled: true, actions: [{ appId: 'app.test', delaySeconds: 20 }] };
  assert.strictEqual(request('POST', value, { origin: 'http://evil.example' }).code, 403);
  assert.strictEqual(request('POST', value, { type: 'text/plain' }).code, 415);
  config.allowControl = false;
  assert.strictEqual(request('POST', value).code, 403);
  config.allowControl = true;
  assert.strictEqual(request('POST', { enabled: true, actions: [] }).code, 400);
  assert.strictEqual(request('POST', value).code, 200);
  assert.deepEqual(config.scheduledApps, value);
  var saved = JSON.parse(fs.readFileSync(file));
  assert.strictEqual(saved.token, 'unit-token');
  assert.strictEqual(saved.remoteDesktop.enabled, true);
  assert.deepEqual(saved.scheduledApps, value);
  console.log('Scheduled routes: token, Origin, content type, read-only guard, validation, native timer read and config persistence pass.');
} finally {
  fs.chmodSync = oldMode;
  fs.readdirSync(dir).forEach(function (file) { fs.unlinkSync(path.join(dir, file)); });
  fs.rmdirSync(dir);
}
