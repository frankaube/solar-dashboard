import { KASA_PORT, kasaSysinfo } from '../kasa.adapter';
import { esphomeInfo } from '../esphome.adapter';
import { shellyInfo } from '../shelly.adapter';
import { tasmotaInfo } from '../tasmota.adapter';
import { sweepHap, sweepMdns } from '../mdns';
import { sweepTuya } from '../tuya-discovery';
import { SUNSPEC_PORT, sunspecIdentify } from '../sunspec';
import { sunspecHasStorage } from '../../battery/sunspec-battery';
import { daikinIdentify, sweepDaikin } from '../daikin';
import { describeDeviceType, sweepMidea } from '../midea';
import { DiscoveryProbe, ListenProbe, PortProbe } from './types';

const HTTP_PORT = 80;
/** Tuya local control. Open on every Tuya device, and a usable fingerprint on its own. */
const TUYA_CONTROL_PORT = 6668;

/** HomeKit accessory category → our device kind. */
const HAP_KINDS: Record<number, string> = { 5: 'light', 8: 'switch', 9: 'thermostat' };

const kasa: PortProbe = {
  vendor: 'kasa',
  label: 'Kasa / TP-Link',
  port: KASA_PORT,
  async identify(host, ctx) {
    const info = await kasaSysinfo(host);
    return {
      vendor: 'kasa',
      kind: info.mic_type?.includes('SWITCH') ? 'switch' : 'plug',
      name: info.alias ?? info.model ?? 'Kasa device',
      host,
      hardwareId: info.mac,
      model: info.model,
      adopted: ctx.isAdopted('kasa', info.mac),
    };
  },
};

/*
  Shelly, Tasmota and ESPHome all answer on port 80, so they share one sweep and are tried
  in priority order; the first to recognise a host claims it.
*/
const shelly: PortProbe = {
  vendor: 'shelly',
  label: 'Shelly',
  port: HTTP_PORT,
  priority: 1,
  async identify(host, ctx) {
    const info = await shellyInfo(host);
    if (!info.id && !info.model) return null;
    return {
      vendor: 'shelly',
      kind: 'plug',
      name: info.name || info.app || info.model || 'Shelly',
      host,
      hardwareId: info.mac ?? info.id,
      model: info.model,
      adopted: ctx.isAdopted('shelly', info.mac ?? info.id),
    };
  },
};

const tasmota: PortProbe = {
  vendor: 'tasmota',
  label: 'Tasmota',
  port: HTTP_PORT,
  priority: 2,
  async identify(host, ctx) {
    const info = await tasmotaInfo(host);
    return {
      vendor: 'tasmota',
      kind: 'plug',
      name: info.name || 'Tasmota plug',
      host,
      hardwareId: info.mac,
      model: info.hardware,
      adopted: ctx.isAdopted('tasmota', info.mac),
    };
  },
};

const esphome: PortProbe = {
  vendor: 'esphome',
  label: 'ESPHome',
  port: HTTP_PORT,
  priority: 3,
  async identify(host, ctx) {
    const info = await esphomeInfo(host);
    return {
      vendor: 'esphome',
      kind: info.metered ? 'meter' : 'sensor',
      name: info.name || 'ESPHome device',
      host,
      hardwareId: host, // no MAC over the web API
      model: `${info.entities} entities`,
      adopted: ctx.isAdopted('esphome', host),
    };
  },
};

/**
 * Tuya over TCP. Yields only an address — no device id, no protocol version — but survives
 * Docker bridge networking, where the broadcast listener below hears nothing.
 */
const tuyaPort: PortProbe = {
  vendor: 'tuya',
  label: 'Tuya (Smart Life, and most white-label plugs)',
  port: TUYA_CONTROL_PORT,
  async identify(host, ctx) {
    return {
      vendor: 'tuya',
      kind: 'plug',
      name: `Tuya device at ${host}`,
      host,
      model: 'Tuya (id unknown)',
      adopted: ctx.isAdopted('tuya', host),
      needsCloudKey: true,
    };
  },
};

/**
 * Daikin over HTTP, sharing the port-80 sweep. Last in priority there, so only a host that
 * is none of Shelly/Tasmota/ESPHome is asked whether it is an air conditioner. This is the
 * path that works in Docker; the broadcast probe below cannot cross a bridge network.
 */
const daikinHttp: PortProbe = {
  vendor: 'daikin',
  label: 'Daikin air conditioners (legacy Wi-Fi adaptor)',
  port: HTTP_PORT,
  priority: 4,
  async identify(host, ctx) {
    const info = await daikinIdentify(host);
    if (!info) return null;
    return {
      vendor: 'daikin',
      kind: 'thermostat',
      name: info.name,
      host,
      hardwareId: info.mac,
      model: info.firmware ? `Daikin adaptor · fw ${info.firmware}` : 'Daikin adaptor',
      adopted: ctx.isAdopted('daikin', info.mac),
    };
  },
};

/** Daikin's own broadcast. Better where it works; silent behind a Docker bridge. */
const daikinBroadcast: ListenProbe = {
  vendor: 'daikin',
  label: 'Daikin air conditioners (legacy Wi-Fi adaptor)',
  async listen(_subnetPrefix, ctx) {
    const found = await sweepDaikin();
    return found.map((info) => ({
      vendor: 'daikin',
      kind: 'thermostat',
      name: info.name,
      host: info.host,
      hardwareId: info.mac,
      model: info.firmware ? `Daikin adaptor · fw ${info.firmware}` : 'Daikin adaptor',
      adopted: ctx.isAdopted('daikin', info.mac),
    }));
  },
};

/**
 * SunSpec over Modbus TCP — Fronius, SMA, SolarEdge, Delta and ABB share the register map,
 * and manufacturer, model and serial come out of the Common Model. Reported as a `meter`
 * kind: identifying hardware is not the same as having an adapter for it.
 */
const sunspec: PortProbe = {
  vendor: 'sunspec',
  label: 'SunSpec inverters and batteries (Fronius, SMA, SolarEdge, ABB…)',
  port: SUNSPEC_PORT,
  async identify(host, ctx) {
    const info = await sunspecIdentify(host);
    if (!info) return null; // Modbus, but not SunSpec — plenty of gear answers on 502
    /*
      Ask the same device whether it also stores energy, so a hybrid inverter is not
      reported as a plain meter. One extra read, only against hosts already known to speak
      SunSpec.
    */
    const storage = await sunspecHasStorage(host);
    const name = [info.manufacturer, info.model].filter(Boolean).join(' ') || 'SunSpec device';
    return {
      vendor: 'sunspec',
      kind: storage ? 'battery' : 'meter',
      name: storage ? `${name} (battery)` : name,
      host,
      hardwareId: info.serial || host,
      model: info.version ? `${info.model} · fw ${info.version}` : info.model,
      adopted: ctx.isAdopted('sunspec', info.serial || host),
    };
  },
};

const homekit: ListenProbe = {
  vendor: 'homekit',
  label: 'HomeKit accessories (incl. Mysa)',
  async listen(subnetPrefix, ctx) {
    const found = await sweepHap(subnetPrefix);
    return found.map((hap) => {
      const vendor = hap.model.toLowerCase().startsWith('mysa') ? 'mysa' : 'homekit';
      return {
        vendor,
        kind: HAP_KINDS[hap.category] ?? 'sensor',
        name: hap.name,
        host: hap.host,
        port: hap.port,
        hardwareId: hap.hapId,
        model: hap.model,
        paired: hap.paired,
        adopted: ctx.isAdopted(vendor, hap.hapId),
      };
    });
  },
};

/**
 * ESPHome over mDNS. The port-80 probe misses a device with `web_server` disabled, which is
 * off on plenty of real configs; ESPHome always registers `_esphomelib._tcp` on its native
 * API port. Reported as needing attention, since the adapter still needs the web server on.
 */
const esphomeMdns: ListenProbe = {
  vendor: 'esphome',
  label: 'ESPHome',
  async listen(subnetPrefix, ctx) {
    const responders = await sweepMdns(subnetPrefix, '_esphomelib._tcp.local');
    return responders.map((r) => ({
      vendor: 'esphome',
      kind: 'sensor',
      name: r.txt.friendly_name || r.name || 'ESPHome device',
      host: r.host,
      hardwareId: r.txt.mac ?? r.host,
      model: [r.txt.board, r.txt.version && `ESPHome ${r.txt.version}`]
        .filter(Boolean)
        .join(' · ') || 'ESPHome',
      adopted: ctx.isAdopted('esphome', r.txt.mac ?? r.host),
    }));
  },
};

/**
 * Midea and the brands on the same hardware — Senville, Pioneer, Carrier, Toshiba (North
 * America), Klimaire.
 *
 * Discovery needs no credential: the reply is encrypted with a published constant. Control
 * does — V3 units need a token from a cloud endpoint Midea is shutting down — so these are
 * reported as found, not supported. NOT claimed as an energy source: the energy bytes have
 * two incompatible decodings no library disambiguates, so a figure could be 100x wrong.
 */
const midea: ListenProbe = {
  vendor: 'midea',
  label: 'Midea air conditioners (also Senville, Pioneer, Carrier, Toshiba NA)',
  async listen(_subnetPrefix, ctx) {
    const found = await sweepMidea();
    return found.map((d) => ({
      vendor: 'midea',
      kind: d.deviceType === 0xac ? 'thermostat' : 'sensor',
      name: `Midea ${describeDeviceType(d.deviceType)} ${d.ssid.split('_').pop() ?? ''}`.trim(),
      host: d.host,
      port: d.port,
      hardwareId: d.serialNumber || d.mac || d.host,
      model: [d.ssid, d.firmware && `fw ${d.firmware}`, `v${d.protocolVersion}`]
        .filter(Boolean)
        .join(' · '),
      adopted: ctx.isAdopted('midea', d.serialNumber || d.mac || d.host),
      // V3 needs a cloud-issued token before anything can be read or controlled.
      needsCloudKey: d.protocolVersion === 3,
    }));
  },
};

/**
 * Shelly over mDNS. Redundant with the port-80 probe, which needs an embedded HTTP stack to
 * answer promptly during a 254-host sweep — exactly the stacks documented to wedge under
 * load. Gen2+ devices advertise `_shelly._tcp`; Gen1 does not and is still found over HTTP.
 * The two paths merge on vendor+host.
 */
const shellyMdns: ListenProbe = {
  vendor: 'shelly',
  label: 'Shelly',
  async listen(subnetPrefix, ctx) {
    const responders = await sweepMdns(subnetPrefix, '_shelly._tcp.local');
    return responders.map((r) => ({
      vendor: 'shelly',
      kind: 'plug',
      name: r.txt.id || r.name || 'Shelly',
      host: r.host,
      hardwareId: r.txt.id ?? r.host,
      model: [r.txt.app, r.txt.gen && `gen ${r.txt.gen}`].filter(Boolean).join(' · ') || 'Shelly',
      adopted: ctx.isAdopted('shelly', r.txt.id ?? r.host),
    }));
  },
};

/**
 * The better half of Tuya discovery: devices announce their id, protocol version and
 * encryption flag, so no probing is needed. Does not work from a bridge-networked container
 * — broadcasts to 255.255.255.255 do not cross the bridge — where the TCP probe covers.
 */
const tuyaBroadcast: ListenProbe = {
  vendor: 'tuya',
  label: 'Tuya (Smart Life, and most white-label plugs)',
  async listen(_subnetPrefix, ctx) {
    const found = await sweepTuya();
    return found.map((tuya) => ({
      vendor: 'tuya',
      kind: 'plug',
      name: `Tuya device ${tuya.gwId.slice(-6)}`,
      host: tuya.host,
      hardwareId: tuya.gwId,
      model: `Tuya v${tuya.version}`,
      adopted: ctx.isAdopted('tuya', tuya.gwId),
      needsCloudKey: tuya.encrypted,
    }));
  },
};

/**
 * The registry. Adding a vendor means writing a probe and adding it here.
 *
 * Known gaps, ordered by whether the platform reports ENERGY rather than by how common it
 * is — see docs/device-discovery.md.
 *
 *   (done) SunSpec Modbus TCP 502
 *   (done) Daikin UDP 30050 + HTTP
 *   (done) Midea UDP 6445/20086 — DISCOVERY ONLY; energy is not trustworthy, see midea.ts
 *   (done) Shelly mDNS. Tasmota has no standard mDNS service — not attempted.
 *   Gree    UDP 7000        — control only, verified never reports power
 *   Broadlink UDP 80        — IR bridges, zero telemetry
 *
 * Watch the collision: Tuya and Gree both use UDP 7000 in places. Disambiguate on
 * payload (Gree is JSON, Tuya length-prefixed binary), never on port alone.
 */
export const DISCOVERY_PROBES: DiscoveryProbe[] = [
  kasa,
  shelly,
  tasmota,
  esphome,
  tuyaPort,
  sunspec,
  daikinHttp,
  esphomeMdns,
  shellyMdns,
  homekit,
  tuyaBroadcast,
  daikinBroadcast,
  midea,
];
