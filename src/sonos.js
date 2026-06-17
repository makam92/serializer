'use strict';

/**
 * Sonos discovery (and, later, control) over the local network.
 *
 * Networks with VLANs (a common office setup) put Sonos on a different subnet
 * from the Mac. Unicast routes across subnets, but multicast usually does not —
 * so plain SSDP discovery finds nothing. What *does* cross is mDNS, when the
 * network runs a Bonjour reflector. So we:
 *
 *   1. Get one Sonos IP ("seed") via the system Bonjour daemon (`dns-sd`).
 *   2. Ask that seed for the whole topology over unicast (GetZoneGroupState),
 *      which lists every room, its IP, and how they're grouped.
 *
 * If the daemon route yields nothing (e.g. non-macOS, or no Sonos), we fall back
 * to classic SSDP, which works fine when the Mac and Sonos share a subnet.
 *
 * No external dependencies — UDP, HTTP, and the built-in `dns-sd` tool.
 */

const dgram = require('node:dgram');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const SONOS_HTTP_PORT = 1400;

// ---------------------------------------------------------------------------
// HTTP helpers (unicast — works across subnets)
// ---------------------------------------------------------------------------
// NB: no keep-alive agent — Sonos/UPnP players close idle connections, so a
// pooled stale socket gets reused and hangs until timeout. A fresh connection
// per request is reliable (and request volume is already throttled).
function httpRequest(options, body, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(fragment, name) {
  const m = fragment.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// Seed discovery via the system Bonjour daemon (`dns-sd`)
// ---------------------------------------------------------------------------
/** Run a `dns-sd` command, resolving as soon as `parse(output)` returns truthy. */
function runDnssd(args, parse, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn('dns-sd', args); }
    catch { resolve(null); return; }
    let out = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}
      resolve(val);
    };
    proc.stdout.on('data', (d) => { out += d.toString(); const v = parse(out); if (v) finish(v); });
    proc.on('error', () => finish(null));
    setTimeout(() => finish(parse(out) || null), timeoutMs);
  });
}

/** Find one reachable Sonos IP using mDNS, to seed a topology query. */
async function seedViaDnssd() {
  const instance = await runDnssd(
    ['-B', '_sonos._tcp', 'local.'],
    (out) => { const m = out.match(/\bAdd\b.*_sonos\._tcp\.\s+(\S.*?)\s*$/m); return m && m[1]; },
    3500,
  );
  if (!instance) return null;

  const host = await runDnssd(
    ['-L', instance, '_sonos._tcp', 'local.'],
    (out) => { const m = out.match(/can be reached at (\S+?):/i); return m && m[1].replace(/\.$/, ''); },
    3000,
  );
  if (!host) return null;

  const ip = await runDnssd(
    ['-G', 'v4', host],
    (out) => { const m = out.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/); return m && m[1]; },
    3000,
  );
  return ip || null;
}

// ---------------------------------------------------------------------------
// Topology over unicast — enumerate every room from one seed
// ---------------------------------------------------------------------------
async function getZoneGroupState(ip) {
  const soap = '<?xml version="1.0"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + '<s:Body><u:GetZoneGroupState xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"></u:GetZoneGroupState></s:Body></s:Envelope>';
  const { status, body } = await httpRequest({
    host: ip, port: SONOS_HTTP_PORT, path: '/ZoneGroupTopology/Control', method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: '"urn:schemas-upnp-org:service:ZoneGroupTopology:1#GetZoneGroupState"',
      'Content-Length': Buffer.byteLength(soap),
    },
  }, soap);
  if (status !== 200) throw new Error(`ZoneGroupState HTTP ${status}`);
  const inner = body.match(/<ZoneGroupState>([\s\S]*?)<\/ZoneGroupState>/i);
  if (!inner) throw new Error('no ZoneGroupState in response');
  return unescapeXml(inner[1]);
}

/** Parse the topology XML into one entry per visible room. */
function parseRooms(zoneGroupStateXml) {
  const byRoom = new Map();
  const members = zoneGroupStateXml.match(/<ZoneGroupMember\b[^>]*>/gi) || [];
  for (const frag of members) {
    if (attr(frag, 'Invisible') === '1') continue; // satellites, bonded subs, bridges
    const roomName = attr(frag, 'ZoneName');
    const location = attr(frag, 'Location');
    const id = attr(frag, 'UUID');
    const ipMatch = location.match(/https?:\/\/([\d.]+):/);
    const ip = ipMatch ? ipMatch[1] : '';
    if (!roomName || !ip || byRoom.has(roomName)) continue;
    byRoom.set(roomName, { id, ip, roomName, location });
  }
  return [...byRoom.values()].sort((a, b) => a.roomName.localeCompare(b.roomName));
}

/** Enrich a room with its model name and current volume/bass (unicast fetches). */
async function enrich(room) {
  const out = { ...room, model: 'Sonos', volume: 25, bass: 0 };
  try {
    const { body } = await httpRequest({ host: room.ip, port: SONOS_HTTP_PORT, path: '/xml/device_description.xml', method: 'GET' });
    out.model = tag(body, 'modelName') || 'Sonos';
  } catch {}
  try { out.volume = await getVolume(room.ip); } catch {}
  try { out.bass = await getBass(room.ip); } catch {}
  return out;
}

// ---------------------------------------------------------------------------
// SSDP fallback (works when Mac and Sonos share a subnet)
// ---------------------------------------------------------------------------
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

function discoverSsdp(timeoutMs) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const seen = new Set();
    const pending = [];
    const byRoom = new Map();
    const pkt = Buffer.from([
      'M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, 'MAN: "ssdp:discover"',
      'MX: 1', 'ST: urn:schemas-upnp-org:device:ZonePlayer:1', '', '',
    ].join('\r\n'));

    sock.on('message', (msg) => {
      const m = msg.toString('utf8').match(/LOCATION:\s*(\S+)/i);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      // NB: a WHATWG URL has no own enumerable props, so {...new URL()} is {} —
      // build the request options explicitly.
      const u = new URL(m[1]);
      pending.push(httpRequest({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET' }).then(({ body }) => {
        const room = tag(body, 'roomName') || tag(body, 'friendlyName');
        if (room && !byRoom.has(room)) {
          byRoom.set(room, { id: tag(body, 'UDN').replace(/^uuid:/, ''), ip: u.hostname, roomName: room, model: tag(body, 'modelName') || 'Sonos', volume: 25, bass: 0, location: m[1] });
        }
      }).catch(() => {}));
    });
    sock.on('error', () => { try { sock.close(); } catch {} resolve([]); });
    sock.bind(() => {
      try { sock.setMulticastTTL(4); } catch {}
      const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
      const sendAll = () => {
        try { sock.send(pkt, 0, pkt.length, SSDP_PORT, SSDP_ADDR); } catch {}
        for (const i of ifaces) { try { sock.setMulticastInterface(i.address); sock.send(pkt, 0, pkt.length, SSDP_PORT, SSDP_ADDR); } catch {} }
      };
      sendAll(); setTimeout(sendAll, 300); setTimeout(sendAll, 900);
    });
    setTimeout(async () => {
      try { sock.close(); } catch {}
      await Promise.allSettled(pending);
      resolve([...byRoom.values()].sort((a, b) => a.roomName.localeCompare(b.roomName)));
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Control (AVTransport over unicast)
// ---------------------------------------------------------------------------
function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function soapEnvelope(serviceType, action, inner) {
  return '<?xml version="1.0"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`;
}

async function avAction(ip, action, inner) {
  const serviceType = 'urn:schemas-upnp-org:service:AVTransport:1';
  const body = soapEnvelope(serviceType, action, `<InstanceID>0</InstanceID>${inner}`);
  return httpRequest({
    host: ip, port: SONOS_HTTP_PORT, path: '/MediaRenderer/AVTransport/Control', method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${serviceType}#${action}"`,
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
}

/** Minimal DIDL-Lite describing our live stream as an audio broadcast. */
function streamMetadata(url, title = 'Serializer') {
  return '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" '
    + 'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
    + 'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" '
    + 'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
    + '<item id="0" parentID="-1" restricted="true">'
    + `<dc:title>${xmlEsc(title)}</dc:title>`
    + '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>'
    + `<res protocolInfo="http-get:*:audio/wav:*">${xmlEsc(url)}</res>`
    + '</item></DIDL-Lite>';
}

async function setUri(ip, uri, metadata = '') {
  return avAction(ip, 'SetAVTransportURI',
    `<CurrentURI>${xmlEsc(uri)}</CurrentURI><CurrentURIMetaData>${xmlEsc(metadata)}</CurrentURIMetaData>`);
}
async function play(ip) { return avAction(ip, 'Play', '<Speed>1</Speed>'); }
async function stop(ip) { return avAction(ip, 'Stop', ''); }

async function transportState(ip) {
  const { body } = await avAction(ip, 'GetTransportInfo', '');
  return (body.match(/<CurrentTransportState>([^<]*)</i) || [])[1] || '?';
}

async function currentTrackUri(ip) {
  const { body } = await avAction(ip, 'GetPositionInfo', '');
  return (body.match(/<TrackURI>([^<]*)</i) || [])[1] || '';
}

// ---- Volume & bass (RenderingControl) — per player, even when grouped ----
async function rcAction(ip, action, inner) {
  const serviceType = 'urn:schemas-upnp-org:service:RenderingControl:1';
  const body = soapEnvelope(serviceType, action, `<InstanceID>0</InstanceID>${inner}`);
  return httpRequest({
    host: ip, port: SONOS_HTTP_PORT, path: '/MediaRenderer/RenderingControl/Control', method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${serviceType}#${action}"`,
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
}

async function setVolume(ip, vol) {
  const v = Math.max(0, Math.min(100, Math.round(vol)));
  return rcAction(ip, 'SetVolume', `<Channel>Master</Channel><DesiredVolume>${v}</DesiredVolume>`);
}
async function getVolume(ip) {
  const { body } = await rcAction(ip, 'GetVolume', '<Channel>Master</Channel>');
  return parseInt((body.match(/<CurrentVolume>([^<]*)</i) || [])[1] || '0', 10);
}
async function setBass(ip, bass) {
  const b = Math.max(-10, Math.min(10, Math.round(bass)));
  return rcAction(ip, 'SetBass', `<DesiredBass>${b}</DesiredBass>`);
}
async function getBass(ip) {
  const { body } = await rcAction(ip, 'GetBass', '');
  return parseInt((body.match(/<CurrentBass>([^<]*)</i) || [])[1] || '0', 10);
}

/**
 * Play a stream URL on one or more rooms in sync. The first room is the group
 * coordinator and actually streams; the rest join its group (x-rincon) so Sonos
 * keeps them locked together.
 * @param {Array<{id:string, ip:string, roomName:string}>} rooms
 * @param {string} streamUrl
 */
async function playStream(rooms, streamUrl) {
  if (!rooms.length) return null;
  const [coord, ...followers] = rooms;
  for (const f of followers) await setUri(f.ip, `x-rincon:${coord.id}`);
  await setUri(coord.ip, streamUrl, streamMetadata(streamUrl));
  await play(coord.ip);
  return coord;
}

async function stopAll(rooms) {
  for (const r of rooms) { try { await stop(r.ip); } catch {} }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Discover Sonos rooms on the LAN. Tries the mDNS-seed + unicast-topology route
 * first (works across VLANs), then falls back to SSDP (same-subnet networks).
 * @returns {Promise<Array<{id:string, ip:string, roomName:string, model:string, location:string}>>}
 */
async function discover(timeoutMs = 4000) {
  const seed = await seedViaDnssd();
  if (seed) {
    try {
      const rooms = parseRooms(await getZoneGroupState(seed));
      if (rooms.length) return Promise.all(rooms.map(enrich));
    } catch { /* fall through to SSDP */ }
  }
  return discoverSsdp(timeoutMs);
}

module.exports = {
  discover,
  setUri, play, stop, transportState, currentTrackUri, playStream, stopAll, streamMetadata,
  setVolume, getVolume, setBass, getBass,
};
