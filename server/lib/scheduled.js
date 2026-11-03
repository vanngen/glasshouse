// Apps after LG's On Timer, not after ordinary power-on. Strict ES5.
var fs = require('fs');
var util = require('./util');
var msg = require('./say').msg;
var config = {};
var liveState = null;
var luna = null;
var control = null;
var file = '/var/lib/tvweb/scheduled-apps-state.json';
var bootId = '';
var runtime = { wake: null, lastRun: null, observed: null };
var generation = 0;
var cancelWait = null;
var started = false;
var wakeClock = 0;
var clock = util.monotonicMs;
var now = Date.now;
function defaultLater(fn, ms) {
  var timer = setTimeout(fn, ms);
  return function () { clearTimeout(timer); };
}
var later = defaultLater;

function settings() {
  var s = config.scheduledApps || {};
  return { enabled: s.enabled === true, actions: Array.isArray(s.actions) ? s.actions : [] };
}

function validate(body) {
  if (!body || typeof body.enabled !== 'boolean' || !Array.isArray(body.actions) || body.actions.length > 10) {
    return { error: msg('srv.scheduled.invalid', 'Choose whether scheduled apps are enabled and up to 10 apps.') };
  }
  var actions = [], used = {};
  for (var i = 0; i < body.actions.length; i++) {
    var a = body.actions[i];
    if (!a || typeof a.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(a.appId) ||
        used[a.appId] || typeof a.delaySeconds !== 'number' || a.delaySeconds % 1 !== 0 || a.delaySeconds < 5 || a.delaySeconds > 600) {
      return { error: msg('srv.scheduled.action', 'Choose each app once and a whole-second delay between 5 and 600 seconds.') };
    }
    used[a.appId] = true;
    actions.push({ appId: a.appId, delaySeconds: a.delaySeconds });
  }
  if (body.enabled && !actions.length) return { error: msg('srv.scheduled.empty', 'Add an app before enabling scheduled launches.') };
  return { value: { enabled: body.enabled, actions: actions } };
}

function save() {
  try { util.writeJsonAtomic(file, runtime, parseInt('600', 8)); return true; }
  catch (e) {
    console.error('scheduled: could not save run state: ' + e.message);
    return false;
  }
}

function on() {
  return !!(liveState && liveState.state.snapshot().power && liveState.state.snapshot().power.systemOn === true);
}

function stopPending(reason) {
  generation++;
  if (cancelWait) cancelWait();
  cancelWait = null;
  if (runtime.lastRun && runtime.lastRun.state === 'running') {
    runtime.lastRun.state = 'cancelled';
    runtime.lastRun.note = reason;
    runtime.lastRun.steps.forEach(function (step) {
      if (step.state === 'pending') step.state = 'cancelled';
      else if (step.state === 'running') step.state = 'interrupted';
    });
    save();
  }
}

function nextStep(gen) {
  if (gen !== generation) return;
  if (!settings().enabled || !config.allowControl || !on()) return stopPending('TV off, controls disabled, or schedule changed');
  var run = runtime.lastRun;
  var step = null;
  for (var i = 0; i < run.steps.length; i++) if (run.steps[i].state === 'pending') { step = run.steps[i]; break; }
  if (!step) {
    run.state = run.steps.some(function (s) { return s.state === 'failed' || s.state === 'interrupted'; }) ? 'finished-with-errors' : 'completed';
    save();
    return;
  }
  cancelWait = later(function () {
    cancelWait = null;
    if (gen !== generation) return;
    if (!settings().enabled || !config.allowControl || !on()) return stopPending('TV off or schedule disabled');
    // Persist before sending a launch. An interrupted send is never repeated.
    step.state = 'running';
    step.at = now();
    if (!save()) { run.state = 'failed'; return; }
    luna('com.webos.applicationManager/getAppInfo', { id: step.appId }, function (info) {
      if (gen !== generation) return;
      if (!info || !info.returnValue) {
        step.state = 'failed'; step.error = 'App is no longer installed';
        save(); return nextStep(gen);
      }
      if (!config.allowControl || !on()) return stopPending('TV off or controls disabled');
      control('launchApp', step.appId, function (result) {
        if (gen !== generation) return;
        step.state = result && result.ok ? 'completed' : 'failed';
        if (step.state === 'failed') step.error = 'App launch failed';
        console.log('scheduled: ' + step.appId + ' ' + step.state);
        save(); nextStep(gen);
      });
    });
  }, Math.max(0, step.delaySeconds * 1000 - (clock() - wakeClock)));
}

function sameWake(a, b) {
  return !!(a && b && a.bootId === b.bootId && Math.abs(a.second - b.second) <= 3);
}

function inspectWake() {
  if (!started || !settings().enabled || !config.allowControl || !on()) return;
  var gen = generation;
  luna('com.webos.service.tvpower/power/getPowerOnReason', {}, function (reasonReply) {
    if (gen !== generation || !on()) return;
    var reason = reasonReply && reasonReply.returnValue !== false ? reasonReply.reason : null;
    runtime.observed = { at: now(), reason: reason || null };
    if (reason !== 'onTimer') { save(); return; }
    luna('com.webos.service.tvpower/power/getPowerOnTime', {}, function (reply) {
      if (gen !== generation || !on()) return;
      var time = reply && reply.returnValue !== false && reply.time;
      var uptime = time ? Number(time.uptime) : NaN;
      var elapsed = time ? Number(time.ontime) : NaN;
      if (!bootId || !isFinite(uptime) || !isFinite(elapsed) || elapsed <= 0 || elapsed > 600 || uptime < elapsed) return;
      var wake = { bootId: bootId, second: uptime - elapsed };
      wakeClock = clock() - elapsed * 1000;
      if (sameWake(runtime.wake, wake)) {
        if (!runtime.lastRun || runtime.lastRun.state !== 'running') return;
        runtime.lastRun.steps.forEach(function (step) { if (step.state === 'running') step.state = 'interrupted'; });
      } else {
        // Do not launch retrospectively after restarting Glasshouse much later.
        if (elapsed > 180) return;
        var valid = validate(settings());
        if (valid.error || !valid.value.actions.length) return;
        runtime.wake = wake;
        runtime.lastRun = {
          at: now(), reason: reason, state: 'running', note: '',
          steps: valid.value.actions.map(function (a, index) {
            return { appId: a.appId, delaySeconds: a.delaySeconds, index: index, state: 'pending' };
          }).sort(function (a, b) { return a.delaySeconds - b.delaySeconds || a.index - b.index; })
        };
      }
      if (save()) nextStep(gen);
    });
  });
}

function considerWake() {
  generation++;
  if (cancelWait) cancelWait();
  var gen = generation;
  cancelWait = later(function () { cancelWait = null; if (gen === generation) inspectWake(); }, 1500);
}

function apply(value) {
  stopPending('Schedule changed');
  config.scheduledApps = value;
}

function status() {
  return { settings: settings(), lastRun: runtime.lastRun, observed: runtime.observed };
}

function start() {
  if (started) return;
  started = true;
  liveState.state.onChange(function (event) {
    if (event.group !== 'power' || event.key !== 'systemOn') return;
    if (event.value === true) considerWake();
    else stopPending('TV switched off');
  });
  if (on()) considerWake();
}

function init(opts) {
  if (cancelWait) cancelWait();
  generation++;
  cancelWait = null;
  started = false;
  config = opts.config;
  liveState = opts.liveState;
  luna = opts.luna;
  control = opts.control;
  file = opts.stateFile || '/var/lib/tvweb/scheduled-apps-state.json';
  clock = opts.clock || util.monotonicMs;
  now = opts.now || Date.now;
  later = opts.later || defaultLater;
  try { bootId = opts.bootId || fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { bootId = ''; }
  runtime = { wake: null, lastRun: null, observed: null };
  try {
    var saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && saved.wake && saved.lastRun && Array.isArray(saved.lastRun.steps)) runtime = saved;
  } catch (e) {}
}

module.exports = { init: init, start: start, settings: settings, validate: validate, apply: apply, status: status, sameWake: sameWake };
