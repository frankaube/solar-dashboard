#!/usr/bin/env bash
#
# Get the network back, or reboot trying.
#
# Written after an install went quiet for three and a half hours. The wifi dropped at 04:23,
# the kernel carried on happily — systemd timers kept firing and writing files until 06:53 —
# and the box simply was not on the network any more. Nothing crashed, so nothing restarted;
# the machine sat there healthy and unreachable until somebody noticed and pulled the power.
#
# The escalation matters more than any single step. A wifi link that has lost association
# usually comes back from an interface bounce; one whose driver has wedged needs the module
# reloaded; and a kernel that will do neither needs the machine restarted. Doing only the
# gentlest of those leaves the exact failure this was written for unfixed, and doing only the
# harshest turns a three-second blip into a reboot.
#
# EVERY ACTION IS RECORDED. A box that quietly reboots itself each night looks identical to
# one that is working, right up until the drive dies. The log this writes is read by the app
# and shown on the Health page, because self-healing that hides the fault is worse than the
# fault.
set -uo pipefail

STATE_DIR=/var/lib/solar-dashboard
STATE="$STATE_DIR/netwatch.state"
EVENTS="$STATE_DIR/recovery.jsonl"
# Keep the log to something a human could read, and a Pi never has to think about.
MAX_EVENTS=200

# Consecutive failed checks before each step. The timer runs every minute, so these are
# minutes. Three is long enough that a router reboot or a brief blip passes underneath.
BOUNCE_AFTER=3
RELOAD_AFTER=6
REBOOT_AFTER=12

log_event() {
  local action="$1" detail="$2"
  mkdir -p "$STATE_DIR"
  printf '{"at":"%s","action":"%s","detail":"%s"}\n' \
    "$(date -Is)" "$action" "$detail" >>"$EVENTS"
  # Trim in place, keeping the newest.
  if [ "$(wc -l <"$EVENTS" 2>/dev/null || echo 0)" -gt "$MAX_EVENTS" ]; then
    tail -n "$MAX_EVENTS" "$EVENTS" >"$EVENTS.tmp" && mv "$EVENTS.tmp" "$EVENTS"
  fi
  logger -t solar-netwatch "$action: $detail"
}

# The default gateway, asked for fresh each run: a DHCP lease can move it, and a watchdog
# pinned to yesterday's router address would report the network down forever.
gateway() { ip route show default 2>/dev/null | awk '/default/ {print $3; exit}'; }

# The interface carrying the default route — wlan0 here, eth0 on a wired install. Derived
# rather than hardcoded so this does the right thing when somebody plugs a cable in.
primary_link() { ip route show default 2>/dev/null | awk '/default/ {print $5; exit}'; }

reachable() {
  local gw
  gw="$(gateway)"
  # No default route at all is itself a failure — there is nothing to ping.
  [ -n "$gw" ] || return 1
  ping -c 1 -W 3 "$gw" >/dev/null 2>&1
}

read_count() { [ -f "$STATE" ] && cat "$STATE" 2>/dev/null || echo 0; }

# Only touch the disk when the number actually changed.
#
# This runs every minute forever, and the overwhelmingly common case is a healthy network
# writing the same zero over and over: 1440 writes a day, every one of them a full block on
# the flash this machine boots from, to record that nothing happened. The counter is only
# interesting while it is moving.
write_count() {
  [ "$(read_count)" = "$1" ] && return 0
  mkdir -p "$STATE_DIR"
  echo "$1" >"$STATE"
}

main() {
  if reachable; then
    local previous
    previous="$(read_count)"
    # Only worth a line if it had actually been failing. A success after a success is the
    # normal state of affairs and does not need recording every minute forever.
    if [ "${previous:-0}" -ge "$BOUNCE_AFTER" ]; then
      log_event recovered "network returned after ${previous} failed checks"
    fi
    write_count 0
    return 0
  fi

  local count link
  count=$(( $(read_count) + 1 ))
  write_count "$count"
  link="$(primary_link)"
  # With no default route there is no link to derive; fall back to whatever is up and is
  # not loopback or a container bridge, so a totally dropped route still gets bounced.
  [ -n "$link" ] || link="$(ip -br link show up 2>/dev/null | awk '$1 !~ /^(lo|docker|br-|veth)/ {print $1; exit}')"

  if [ "$count" -ge "$REBOOT_AFTER" ]; then
    log_event reboot "unreachable for ${count} checks; restarting the machine"
    # Cleared first: a reboot loop that re-triggers instantly on every boot is worse than
    # being down, because it never stays up long enough to be fixed remotely.
    write_count 0
    sync
    systemctl reboot
  elif [ "$count" -eq "$RELOAD_AFTER" ]; then
    local driver driver_link
    driver="" ; driver_link="/sys/class/net/$link/device/driver"
    # Only follow it when it really is a symlink.
    #
    # `readlink -f` on a path that is not a link happily returns the path, so a missing
    # driver entry — a USB adapter that has fallen off the bus, a virtual interface, a
    # container — resolved to the basename "driver", and the next line ran
    # `modprobe -r driver`: unloading a module of that name if one existed, and doing
    # nothing useful if not. Found by the test suite running somewhere symlinks could not
    # be created, which is the same shape as the real failure.
    if [ -L "$driver_link" ]; then
      driver="$(basename "$(readlink -f "$driver_link" 2>/dev/null)" 2>/dev/null)"
    fi
    if [ -n "$driver" ] && [ "$driver" != "." ] && [ "$driver" != "driver" ]; then
      log_event driver-reload "unreachable for ${count} checks; reloading ${driver}"
      modprobe -r "$driver" 2>/dev/null && sleep 2 && modprobe "$driver" 2>/dev/null
    else
      log_event driver-reload "unreachable for ${count} checks; no driver found for ${link:-unknown}"
    fi
  elif [ "$count" -eq "$BOUNCE_AFTER" ]; then
    if [ -n "$link" ]; then
      log_event link-bounce "unreachable for ${count} checks; bouncing ${link}"
      ip link set "$link" down 2>/dev/null
      sleep 2
      ip link set "$link" up 2>/dev/null
    else
      log_event link-bounce "unreachable for ${count} checks; no primary link found"
    fi
  fi
}

main "$@"
