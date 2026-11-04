// Microsoft sign-in, a read-only agenda and authenticated To Do transport. Strict ES5.
var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;
var util = require('./util');
var children = require('./children');
var msg = require('./say').msg;
var DEFAULT_CLIENT = '0ffe5808-9b38-4dd2-831b-669b8bbcdb99';
var BASE_SCOPE = 'https://graph.microsoft.com/Calendars.Read offline_access';
var SCOPE = 'https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Tasks.ReadWrite offline_access';
var LOGIN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/';

function form(values) {
  return Object.keys(values).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(values[k]); }).join('&');
}

// Node 0.12's TLS cannot reach Microsoft. Keep credentials on curl's stdin,
// never in process arguments, files in /tmp, URLs, or logs. Never follow redirects.
function microsoftRequest(url, fields, accessToken, cb, options) {
  if (!/^https:\/\/login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\/(devicecode|token)$/.test(url) &&
      !/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/(calendarView|todo\/lists(?:\/[^\/?#]+\/tasks(?:\/[^\/?#]+)?)?)(?:\?[^#]*)?$/.test(url)) {
    return cb(new Error('Unexpected calendar endpoint'));
  }
  var bins = ['/media/developer/bin/curl', '/usr/local/bin/curl', '/opt/bin/curl', '/opt/usr/bin/curl', '/usr/bin/curl'];
  var bin = bins.filter(function (p) { return fs.existsSync(p); })[0];
  if (!bin) return cb(new Error('Calendar connection needs curl on the TV'));
  function quoted(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"'; }
  var input = 'url = ' + quoted(url) + '\n';
  if (accessToken) input += 'header = ' + quoted('Authorization: Bearer ' + accessToken) + '\nheader = ' + quoted('Prefer: outlook.timezone="UTC"') + '\n';
  if (fields) input += 'data = ' + quoted(form(fields)) + '\n';
  if (options && options.method === 'PATCH') {
    if (!/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/todo\/lists\/[^\/?#]+\/tasks\/[^\/?#]+$/.test(url)) return cb(new Error('Invalid task endpoint'));
    input += 'request = "PATCH"\nheader = "Content-Type: application/json"\ndata = ' + quoted(JSON.stringify(options.json)) + '\n';
  }
  children.launch(function () {
    var child = execFile(bin, ['-q', '--silent', '--show-error', '--proto', '=https', '--connect-timeout', '8', '--max-time', '25', '--write-out', '\n%{http_code}', '--config', '-'],
      { timeout: 28000, maxBuffer: 2 * 1024 * 1024 }, function (err, stdout) {
        if (err) return cb(new Error('Could not reach Microsoft; check the TV network and curl'));
        var result, split = stdout.lastIndexOf('\n'), status = Number(stdout.slice(split + 1));
        if (!fields && status >= 400) {
          var refused = new Error('Microsoft rejected the calendar request');
          /** @type {any} */ (refused).httpStatus = status;
          return cb(refused);
        }
        try { result = JSON.parse(stdout.slice(0, split)); } catch (e) { return cb(new Error('Invalid Microsoft response')); }
        cb(null, result);
      });
    child.stdin.on('error', function () {});
    child.stdin.end(input);
  });
}

function create(opts) {
  opts = opts || {};
  var file = opts.stateFile || path.join(__dirname, '..', 'outlook-calendar.json');
  var request = opts.request || microsoftRequest;
  var now = opts.now || Date.now;
  var later = opts.later || function (fn, ms) { var timer = setTimeout(fn, ms); if (timer.unref) timer.unref(); return timer; };
  var cancel = opts.cancel || clearTimeout;
  var saved = util.readJson(file, {});
  var pending = null, timer = null, generation = 0, error = '', busy = false;
  var cache = [], updated = 0, attempted = 0, waiters = [];
  var tokenWaiters = null;

  function persist(value) {
    try { util.writeJsonAtomic(file, value, parseInt('600', 8)); saved = value; return true; }
    catch (e) { error = msg('srv.calendar.save', 'Could not save the calendar connection.'); return false; }
  }
  function status() {
    return { ok: true, connected: !!saved.refreshToken, clientId: saved.clientId || DEFAULT_CLIENT,
      message: error, updated: updated, tasksEnabled: /(^|\s)(https:\/\/graph\.microsoft\.com\/)?Tasks.ReadWrite(\s|$)/.test(saved.scope || ''),
      connectionRevision: generation, pending: pending ? { code: pending.user_code, url: pending.verification_uri, expires: pending.expires } : null };
  }
  function schedule(gen) {
    timer = later(function () { timer = null; poll(gen); }, pending.interval * 1000);
  }
  function poll(gen) {
    if (gen !== generation || !pending) return;
    if (now() >= pending.expires) { pending = null; error = msg('srv.calendar.expired', 'Sign-in expired. Connect Outlook again.'); return; }
    request(LOGIN + 'token', { client_id: pending.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: pending.device_code }, null, function (err, r) {
      if (gen !== generation || !pending) return;
      if (err || (r && (r.error === 'authorization_pending' || r.error === 'slow_down'))) {
        if (r && r.error === 'slow_down') pending.interval += 5;
        return schedule(gen);
      }
      if (!r || !r.refresh_token || !r.access_token) {
        pending = null; error = msg('srv.calendar.denied', 'Microsoft sign-in did not complete. Connect Outlook again.'); return;
      }
      var value = { clientId: pending.clientId, refreshToken: r.refresh_token, accessToken: r.access_token, scope: r.scope || SCOPE, expires: now() + Number(r.expires_in || 3600) * 1000 };
      pending = null;
      if (persist(value)) { cache = []; updated = attempted = 0; error = ''; }
    });
  }
  function begin(body, cb) {
    var id = body && body.clientId || saved.clientId || DEFAULT_CLIENT;
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return cb({ ok: false, error: 'Invalid Microsoft application client ID' });
    generation++;
    var gen = generation;
    if (timer) cancel(timer);
    pending = null;
    request(LOGIN + 'devicecode', { client_id: id, scope: SCOPE }, null, function (err, r) {
      if (gen !== generation) return cb({ ok: false, error: 'Sign-in cancelled' });
      if (err || !r || !r.device_code || !r.user_code || !/^https:\/\/(www\.)?microsoft\.com\//.test(r.verification_uri || '')) {
        return cb({ ok: false, error: msg('srv.calendar.start', 'Could not start Microsoft sign-in. Check the client ID and enable public client flows in the app registration.') });
      }
      error = '';
      pending = { clientId: id, device_code: r.device_code, user_code: r.user_code, verification_uri: r.verification_uri,
        interval: Math.max(5, Number(r.interval) || 5), expires: now() + Math.min(1800, Number(r.expires_in) || 900) * 1000 };
      schedule(gen); cb(status());
    });
  }
  function disconnect(cb) {
    generation++;
    if (timer) cancel(timer);
    pending = null; cache = []; updated = attempted = 0;
    if (!persist({})) return cb({ ok: false, error: error });
    error = ''; cb(status());
  }
  function token(gen, cb, force) {
    if (!force && saved.accessToken && saved.expires > now() + 60000) return cb(null, saved.accessToken);
    if (tokenWaiters) { tokenWaiters.push(cb); return; }
    tokenWaiters = [cb];
    function finish(err, access) {
      var waiting = tokenWaiters; tokenWaiters = null;
      waiting.forEach(function (fn) { fn(err, access); });
    }
    request(LOGIN + 'token', { client_id: saved.clientId, grant_type: 'refresh_token', refresh_token: saved.refreshToken, scope: saved.scope || BASE_SCOPE }, null, function (err, r) {
      if (gen !== generation) return finish(new Error('Calendar connection changed'));
      if (err || !r || !r.access_token) return finish(new Error('Calendar sign-in needs attention'));
      var value = { clientId: saved.clientId, refreshToken: r.refresh_token || saved.refreshToken, accessToken: r.access_token, scope: r.scope || saved.scope || BASE_SCOPE, expires: now() + Number(r.expires_in || 3600) * 1000 };
      if (!persist(value)) return finish(new Error('Could not save calendar sign-in'));
      finish(null, value.accessToken);
    });
  }
  function graph(url, options, cb) {
    var gen = generation;
    if (!saved.refreshToken) return cb(new Error('Microsoft account disconnected'));
    function call(force) {
      token(gen, function (err, access) {
        if (err || gen !== generation) return cb(err || new Error('Microsoft account changed'));
        request(url, null, access, function (err, r) {
          if (gen !== generation) return cb(new Error('Microsoft account changed'));
          if (err && err.httpStatus === 401 && !force) return call(true);
          cb(err, r);
        }, options);
      }, force);
    }
    call(false);
  }
  function normalise(events, start, end) {
    function stamp(v) { var s = v && v.dateTime || ''; return Date.parse(s && !/(Z|[+-]\d\d:\d\d)$/.test(s) ? s + 'Z' : s); }
    return events.filter(function (e) { return !e.isCancelled && stamp(e.end) > start && stamp(e.start) < end; }).map(function (e) {
      return { title: String(e.subject || '').slice(0, 240),
        start: stamp(e.start), end: stamp(e.end), allDay: !!e.isAllDay };
    }).filter(function (e) { return isFinite(e.start) && isFinite(e.end); }).sort(function (a, b) { return a.start - b.start; });
  }
  function agenda(cb) {
    function result() { return { ok: true, connected: !!saved.refreshToken, events: cache.filter(function (e) { return e.end > now(); }), updated: updated,
      stale: !!error, message: error, pending: !!pending, loading: !updated && !error && !pending }; }
    if (!saved.refreshToken) return cb(result());
    if (busy) { waiters.push(cb); return; }
    if (attempted && now() - attempted < 5 * 60000) return cb(result());
    busy = true; attempted = now(); waiters.push(cb);
    var gen = generation, start = now(), end = start + 7 * 86400000;
    var events = [], pages = 0;
    function finish(err) {
      if (gen === generation) {
        if (err) error = err.httpStatus === 401 || err.httpStatus === 403
          ? msg('srv.calendar.refused', 'Microsoft rejected calendar access. Reconnect Outlook and check that this account has an Outlook.com calendar.')
          : msg('srv.calendar.refresh', 'Calendar could not refresh. Check the connection or reconnect Outlook.');
        else { cache = normalise(events, start, end); updated = now(); error = ''; }
      }
      busy = false;
      var callbacks = waiters; waiters = [];
      callbacks.forEach(function (fn) { fn(result()); });
    }
    token(gen, function (err, access) {
      if (err) return finish(err);
      var refreshed = false;
      function page(url) {
        if (gen !== generation) return finish(new Error('Connection changed'));
        request(url, null, access, function (err, r) {
          if (gen === generation && err && err.httpStatus === 401 && !refreshed) {
            refreshed = true;
            return token(gen, function (tokenError, fresh) {
              if (tokenError) return finish(tokenError);
              access = fresh; page(url);
            }, true);
          }
          if (gen !== generation || err || !r || !Array.isArray(r.value)) return finish(err || new Error('Calendar request failed'));
          events = events.concat(r.value); pages++;
          var next = r['@odata.nextLink'];
          if (next) {
            if (pages >= 20 || !/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/calendarView\?/.test(next)) return finish(new Error('Invalid calendar page'));
            return page(next);
          }
          finish(null);
        });
      }
      page('https://graph.microsoft.com/v1.0/me/calendarView?' + form({ startDateTime: new Date(start).toISOString(), endDateTime: new Date(end).toISOString(),
        '$select': 'subject,start,end,isAllDay,isCancelled', '$orderby': 'start/dateTime', '$top': '100' }));
    });
  }
  function refresh() { if (!busy) attempted = 0; agenda(function () {}); return { ok: true }; }
  return { begin: begin, disconnect: disconnect, status: status, agenda: agenda, graph: graph, refresh: refresh };
}

module.exports = { create: create };
