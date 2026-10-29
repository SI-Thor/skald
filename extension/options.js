// skald — options page: LAN server URL configuration.
'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;
const DEFAULT_URL = 'http://localhost:8000';
const $ = (id) => document.getElementById(id);

function normalize(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(s) ? s : DEFAULT_URL;
}

function status(msg, ok) {
  $('status').textContent = msg;
  $('status').style.color = ok ? '#7bc96f' : '#e06c60';
}

(async () => {
  const got = await api.storage.local.get('skald.settings');
  $('serverUrl').value = (got && got['skald.settings'] && got['skald.settings'].serverUrl) || DEFAULT_URL;
})();

$('save').addEventListener('click', async () => {
  const url = normalize($('serverUrl').value);
  const got = await api.storage.local.get('skald.settings');
  const next = { ...(got['skald.settings'] || {}), serverUrl: url };
  await api.storage.local.set({ 'skald.settings': next });
  status(`Saved: ${url}`, true);
});

$('grant').addEventListener('click', async () => {
  const url = normalize($('serverUrl').value);
  const origin = url + '/*';
  try {
    const granted = await api.permissions.request({ origins: [origin] });
    status(granted ? `Permission granted for ${origin}` : 'Permission not granted', granted);
  } catch (err) {
    status('Permission request failed: ' + err.message, false);
  }
});

$('test').addEventListener('click', async () => {
  const url = normalize($('serverUrl').value);
  status('Testing ' + url + ' …');
  try {
    const r = await fetch(url + '/v1/health');
    const j = await r.json();
    status(
      j.upstream && j.upstream.reachable
        ? `OK — daemon v${j.version}, upstream ${j.upstream.riva_http} reachable`
        : 'Daemon reachable but its upstream (Riva) is down',
      !!(j.upstream && j.upstream.reachable)
    );
  } catch (err) {
    status('Unreachable: ' + err.message + ' — check the URL / grant permission', false);
  }
});
