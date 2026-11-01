// Loaded only on a phone or computer. noVNC is imported when the view opens.
let liveRfb = null;
let liveGeneration = 0;
let liveVisible = false;

function liveStatus(text, state) {
  q('liveview-status').textContent = text;
  q('liveview-status').dataset.state = state;
}

function disconnectLiveView() {
  liveGeneration++;
  const old = liveRfb;
  liveRfb = null;
  if (old) old.disconnect();
  q('liveview-screen').replaceChildren();
  q('liveview-connect').disabled = false;
  q('liveview-disconnect').disabled = true;
  liveStatus(t('live.disconnected', 'Disconnected'), 'idle');
}

async function connectLiveView() {
  disconnectLiveView();
  const generation = liveGeneration;
  q('liveview-connect').disabled = true;
  liveStatus(t('live.connecting', 'Connecting to the TV…'), 'busy');
  try {
    const response = await fetch(api('/api/remote-desktop'), { cache: 'no-store' });
    const settings = await response.json();
    if (!response.ok || !settings.ok) throw new Error(settings.error || t('live.unavailable', 'Live TV is unavailable.'));
    const started = await fetch(api('/api/remote-desktop'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    const result = await started.json();
    if (!started.ok || result.returnValue === false || result.ok === false) throw new Error(t('live.startFailed', 'Could not start VNC Server. Check it in Homebrew Channel.'));
    const { default: RFB } = await import('/assets/novnc/core/rfb.js');
    if (!liveVisible || generation !== liveGeneration) return;
    const ws = new URL(api('/api/remote-desktop/socket'), location.href);
    ws.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const rfb = new RFB(q('liveview-screen'), ws.href, {
      credentials: { password: settings.password }, shared: true, wsProtocols: ['binary']
    });
    liveRfb = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = true;
    rfb.qualityLevel = 6;
    rfb.compressionLevel = 2;
    rfb.addEventListener('connect', () => {
      if (liveRfb !== rfb) return;
      q('liveview-disconnect').disabled = false;
      liveStatus(t('live.connected', 'Connected · mouse and keyboard ready'), 'connected');
    });
    rfb.addEventListener('disconnect', event => {
      if (liveRfb !== rfb) return;
      liveRfb = null;
      q('liveview-connect').disabled = false;
      q('liveview-disconnect').disabled = true;
      liveStatus(event.detail.clean ? t('live.disconnected', 'Disconnected') :
        t('live.connectionLost', 'Connection lost. Check that the TV and VNC Server are on, then reconnect.'), 'idle');
    });
    rfb.addEventListener('securityfailure', () => {
      if (liveRfb === rfb) liveStatus(t('live.passwordFailed', 'VNC authentication failed. Check the configured VNC password.'), 'error');
    });
    rfb.addEventListener('credentialsrequired', () => {
      if (liveRfb === rfb) {
        disconnectLiveView();
        liveStatus(t('live.passwordFailed', 'VNC authentication failed. Check the configured VNC password.'), 'error');
      }
    });
  } catch (error) {
    if (generation !== liveGeneration) return;
    q('liveview-connect').disabled = false;
    liveStatus(error.message, 'error');
  }
}

function liveViewVisible(visible) {
  liveVisible = visible;
  if (visible) connectLiveView();
  else disconnectLiveView();
}

q('liveview-connect').addEventListener('click', connectLiveView);
q('liveview-disconnect').addEventListener('click', disconnectLiveView);
q('liveview-fullscreen').addEventListener('click', () => {
  const stage = q('liveview-stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (stage.requestFullscreen) stage.requestFullscreen();
});
window.addEventListener('pagehide', disconnectLiveView);
