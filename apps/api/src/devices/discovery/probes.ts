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
  Shelly, Tasmota and ESPHome all answer on port 80, so they share one sweep and are
  tried in order. Priority matters: each identifies itself by a different endpoint,
  and the first to recognise a host claims it.
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
 * Tuya over TCP. Yields only an address — no device id, no protocol version — but it
 * is the path that survives Docker bridge networking, where the far better broadcast
 * listener below hears nothing at all.
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
 * Daikin over HTTP, sharing the port-80 sweep.
 *
 * Last in priority on that port: Shelly, Tasmota and ESPHome all identify by their own
 * endpoints first, and only a host that is none of those gets asked whether it is an
 * air conditioner.
 *
 * This is the path that works in Docker. The broadcast probe below is better — it needs
 * no sweep at all — but cannot cross a bridge network.
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
 * SunSpec over Modbus TCP — one probe covering many inverter brands.
 *
 * Fronius, SMA, SolarEdge, Delta and ABB all implement the same register map, so
 * this identifies hardware we have no way to test individually. The device names
 * itself: manufacturer, model and serial come straight out of the Common Model.
 *
 * Reported as a `meter` kind rather than adopted-and-ready, because identification
 * is not the same as an adapter. Seeing "Fronius Primo 8.2-1" is worth showing
 * before anything can read watts from it.
 */
const sunspec: PortProbe = {
  vendor: 'sunspec',
  label: 'SunSpec inverters and batteries (Fronius, SMA, SolarEdge, ABB…)',
  port: SUNSPEC_PORT,
  async identify(host, ctx) {
    const info = await sunspecIdentify(host);
    if (!info) return null; // Modbus, but not SunSpec — plenty of gear answers on 502
    /*
      Ask the same device whether it also stores energy.

      The scan used to report every SunSpec device as a meter, so a hybrid inverter with
      a battery in it looked identical to a string inverter without one — and the battery
      page then told the owner nothing had been found, while the thing sitting on their
      wall had been discovered minutes earlier and mislabelled.

      One extra read, only against hosts already known to speak SunSpec.
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
 * ESPHome over mDNS.
 *
 * We ship an ESPHome adapter but only ever found devices by probing port 80, so one
 * with `web_server` disabled — not the default, and off on plenty of real configs —
 * was invisible despite being fully supported. ESPHome always registers
 * `_esphomelib._tcp` on its native API port, so this finds it regardless.
 *
 * Reported as needing attention rather than as ready: the adapter talks to the web
 * server, so a device found this way still has to have it turned on.
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
 * Midea and the brands built on the same hardware — Senville, Pioneer, Carrier,
 * Toshiba (North America), Klimaire.
 *
 * Discovery needs no credential: the reply is encrypted with a published constant.
 * Control is a different matter — V3 units need a token from a cloud endpoint Midea
 * is actively shutting down — so these are reported as found, not as supported.
 *
 * Deliberately NOT claimed as an energy source. Midea AC units can report energy, but
 * the bytes have two incompatible decodings that no existing library disambiguates,
 * so a figure could be wrong by a factor of 100. Finding the device is the honest
 * claim; reading it is not.
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
 * Shelly over mDNS.
 *
 * Purely a reliability addition — the port-80 probe already finds these. But that
 * probe depends on an embedded HTTP stack answering promptly during a 254-host sweep,
 * and those stacks are exactly the ones documented to wedge under load. mDNS asks a
 * different subsystem, so a Shelly busy serving its own web UI still turns up.
 *
 * Gen2+ devices advertise `_shelly._tcp`; Gen1 does not, and is still found by the
 * HTTP probe. If the service name is ever wrong this finds nothing extra rather than
 * breaking anything, since the two paths merge on vendor+host.
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
 * The better half of Tuya discovery: devices announce themselves with their id,
 * protocol version and encryption flag, and no probing is needed at all.
 *
 * Does not work from inside a bridge-networked container — broadcasts to
 * 255.255.255.255 do not cross the bridge. Measured: zero packets in ten seconds
 * inside our own container, while the same code on the host heard the device
 * immediately. Works in the native and Lite builds; the TCP probe covers the rest.
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
 * The registry. Adding a vendor means writing a probe and adding it here — no engine
 * changes, no editing a growing scan() method.
 *
 * Known gaps, ordered the way docs/device-discovery.md argues they should be — by
 * whether the platform reports ENERGY, not by how common it is. A popular platform
 * that only toggles relays is worth less to this app than an obscure one that
 * reports kilowatt-hours.
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
