import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { networkInterfaces } from 'node:os';
import { PrismaService } from '../prisma/prisma.service';
import { MdnsResponder } from './mdns-responder';
import { DEFAULT_HOSTNAME, checkHostname, localName } from './hostname';

/**
 * Owns the mDNS responder, so the name can be changed without an SSH session.
 *
 * It used to be a local variable inside `bootstrap()` — started once, unreachable
 * afterwards, and configurable only by editing an env file on the machine. That is fine
 * until two of these appear on one LAN: both answer for `solar-dashboard.local`, they
 * fight, and renaming one is the only fix.
 *
 * Setting first, then `MDNS_HOSTNAME`, then the default — the same precedence the webhook
 * uses, so an install configured by environment keeps working and the UI can still take
 * over.
 */

export const MDNS_HOSTNAME_SETTING = 'mdnsHostname';
export const MDNS_PORT_DEFAULT = 3001;

/**
 * How long the old name keeps answering after a rename.
 *
 * Renaming breaks the URL the owner is almost certainly reading this on. Stopping the old
 * responder the instant the new one starts would kill the in-flight page load that carried
 * the request — so the old name lingers, long enough for the response to land.
 *
 * Best effort, not a promise. Both responders are bound to UDP 5353 and a query is not
 * reliably delivered to both: measured against a real Pi, the old name answered at T+1 and
 * T+3 in one run and was already silent at T+3 in another. The IP address is the actual
 * guarantee, which is why the card shows it permanently rather than only on failure.
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
    // Goodbye packet on the way out, so the name stops resolving at once rather than
    // pointing at a dead port until the record expires.
    this.responder?.stop();
    this.responder = null;
  }

  private async storedHostname(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: MDNS_HOSTNAME_SETTING } });
    const value = row?.value?.trim();
    if (!value) return null;
    const check = checkHostname(value);
    // A stored name that no longer validates is ignored rather than fatal — it can only
    // come from a hand-edited database, and refusing to boot over it would be worse.
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
   * The LAN address, for the "if the name stops working, use this" line.
   *
   * First non-internal IPv4. A machine with Hyper-V or WSL has several, and the virtual
   * ones are useless to a phone — but picking the wrong one here only degrades a hint,
   * where picking it in the responder would hand out an unreachable address.
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
   * Rename, and keep answering to the old name for a moment.
   *
   * The new responder starts before the old one stops. Both briefly answer, which mDNS
   * copes with — they are different names — and it means the request that asked for the
   * rename can still be answered over the name it arrived on.
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
        // The new name could not be advertised; keep the old responder rather than
        // leaving the install with no name at all.
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
