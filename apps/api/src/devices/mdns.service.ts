import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { networkInterfaces } from 'node:os';
import { PrismaService } from '../prisma/prisma.service';
import { MdnsResponder } from './mdns-responder';
import { DEFAULT_HOSTNAME, checkHostname, localName } from './hostname';

/**
 * Owns the mDNS responder. Two installs on one LAN both answer for `solar-dashboard.local`
 * and fight, so the name has to be changeable at runtime rather than fixed at bootstrap.
 *
 * Setting first, then `MDNS_HOSTNAME`, then the default, so an install configured by
 * environment keeps working and the UI can still take over.
 */

export const MDNS_HOSTNAME_SETTING = 'mdnsHostname';
export const MDNS_PORT_DEFAULT = 3001;

/**
 * How long the old name keeps answering after a rename, so the response to the request that
 * renamed it can still land.
 *
 * Best effort, not a promise: both responders bind UDP 5353 and a query is not reliably
 * delivered to both. The IP address is the actual guarantee, which is why the card shows it
 * permanently.
 */
const OVERLAP_MS = 8_000;

export interface MdnsStatus {
  /** Bare label, no `.local`. */
  hostname: string;
  /** The full URL, or null when the responder could not start. */
  url: string | null;
  running: boolean;
  /** Where the name came from, so "why can I not change it" has an answer. */
  source: 'setting' | 'environment' | 'default';
  /** LAN address, so there is always a way back in if the name stops working. */
  address: string | null;
  port: number;
  /** Why it is not running, when it is not. */
  error: string | null;
}

@Injectable()
export class MdnsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Mdns');
  private responder: MdnsResponder | null = null;
  private hostname = DEFAULT_HOSTNAME;
  private source: MdnsStatus['source'] = 'default';
  private error: string | null = null;
  private readonly port = Number(process.env.PORT ?? MDNS_PORT_DEFAULT);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.MDNS_DISABLE === '1') {
      this.error = 'Disabled by MDNS_DISABLE.';
      return;
    }
    const stored = await this.storedHostname();
    if (stored) {
      this.hostname = stored;
      this.source = 'setting';
    } else if (process.env.MDNS_HOSTNAME) {
      this.hostname = process.env.MDNS_HOSTNAME;
      this.source = 'environment';
    }
    await this.startResponder(this.hostname);
  }

  onModuleDestroy(): void {
    // Goodbye packet, so the name stops resolving at once rather than pointing at a dead
    // port until the record expires.
    this.responder?.stop();
    this.responder = null;
  }

  private async storedHostname(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: MDNS_HOSTNAME_SETTING } });
    const value = row?.value?.trim();
    if (!value) return null;
    const check = checkHostname(value);
    // A stored name that no longer validates is ignored rather than fatal: it can only come
    // from a hand-edited database.
    return check.ok ? check.hostname : null;
  }

  /** Never throws: losing a convenience name is not a reason to fail. */
  private async startResponder(hostname: string): Promise<boolean> {
    const responder = new MdnsResponder({ hostname, port: this.port });
    try {
      await responder.start();
      this.responder = responder;
      this.error = null;
      this.logger.log(`Reachable at http://${localName(hostname)}:${this.port}`);
      return true;
    } catch (error) {
      this.error = (error as Error).message;
      this.logger.warn(
        `Could not advertise ${localName(hostname)} (${this.error}) — use the IP address instead.`,
      );
      return false;
    }
  }

  /**
   * The LAN address, for the "if the name stops working, use this" line. First non-internal
   * IPv4: a machine with Hyper-V or WSL has several, but picking wrong here only degrades a
   * hint, where in the responder it would hand out an unreachable address.
   */
  private address(): string | null {
    for (const list of Object.values(networkInterfaces())) {
      for (const iface of list ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return null;
  }

  status(): MdnsStatus {
    return {
      hostname: this.hostname,
      url: this.responder ? `http://${localName(this.hostname)}:${this.port}` : null,
      running: this.responder !== null,
      source: this.source,
      address: this.address(),
      port: this.port,
      error: this.error,
    };
  }

  /**
   * Rename, keeping the old name answering for a moment: the new responder starts before
   * the old one stops, so the request that asked for the rename can still be answered over
   * the name it arrived on. mDNS copes, since they are different names.
   */
  async rename(raw: string): Promise<MdnsStatus> {
    if (process.env.MDNS_DISABLE === '1') {
      throw new BadRequestException('mDNS is disabled by MDNS_DISABLE on this install.');
    }
    const check = checkHostname(raw);
    if (!check.ok) throw new BadRequestException(check.reason);

    if (check.hostname !== this.hostname) {
      const previous = this.responder;
      const started = await this.startResponder(check.hostname);
      if (!started && previous) {
        // Keep the old responder rather than leaving the install with no name at all.
        this.responder = previous;
        throw new BadRequestException(`Could not advertise ${localName(check.hostname)}: ${this.error}`);
      }
      if (previous) setTimeout(() => previous.stop(), OVERLAP_MS).unref();
    }

    await this.prisma.setting.upsert({
      where: { key: MDNS_HOSTNAME_SETTING },
      create: { key: MDNS_HOSTNAME_SETTING, value: check.hostname },
      update: { value: check.hostname },
    });
    this.hostname = check.hostname;
    this.source = 'setting';
    return this.status();
  }
}
