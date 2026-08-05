# Your plan, and what it makes a kilowatt-hour worth

Most solar dashboards multiply production by one price. That is the right answer for
roughly nobody: what a kilowatt-hour is worth depends on your utility's arrangement, on
whether you used it or sold it, and — under some plans — on what time of day it happened.

This app asks which plan you are on and then values every flow by that plan's own rules.
Change the plan and every dollar figure in the app changes with it, because none of them
are computed from a hardcoded tariff.

---

## The four plans

Chosen in **Settings → Rates → "How you're paid"**.

| Plan | What it means | What it pays for |
|---|---|---|
| **Net metering (1:1 credit)** | Export banks kilowatt-hour for kilowatt-hour and offsets later imports | Everything you produce, plus a premium on what you use yourself |
| **Feed-in tariff** | You are paid a set rate per exported kWh | Export at the feed-in rate, self-use at the retail rate you avoid |
| **Time-of-use** | The rate depends on the hour | Priced hour by hour rather than against a daily average |
| **No export credit** | Export earns nothing | Only what you use as you make it |

The default is net metering, which is what an install that has never touched this setting
resolves to — so nobody's figures move on upgrade.

---

## Why self-use is usually worth more than export

Under net metering the credit is 1:1 in *energy*, not in money. You export a kilowatt-hour
and get a kilowatt-hour back later — but buying that kilowatt-hour back attracts sales tax,
and exporting it did not.

So a kilowatt-hour you use as you make it is worth the full retail price. One you export
and buy back is worth retail minus the tax. On a 15% tax that is about 15% more for
self-use, every day, and a dashboard that ignores it overstates the value of export
permanently.

The Savings page itemises this rather than folding it into one number:

- **Export credits** — what production is worth at the credit rate
- **Tax kept on self-use** — the premium above, and the reason the two differ
- **Not realised** — tax you would have kept had that energy stayed home

That last line is a **ceiling, not a loss**. It is what the energy *could* have been worth
under a different pattern of use, and it is drawn in a dimmer colour for exactly that
reason.

### Which price did you type?

Bills usually print the energy rate *before* tax, and the app needs to know which one you
entered — **Settings → Rates → "Is that price before or after tax?"**. Getting it wrong
does not produce an error; it silently understates or overstates every dollar figure by
the tax rate. This install typed a pre-tax rate into a field the app read as tax-inclusive
and undercounted its savings by 15% until the setting existed.

---

## What one more kilowatt-hour is worth

The Savings page states the **marginal** value: what the *next* kilowatt-hour earns if you
use it versus if you export it, under your plan. That is the number that answers "should I
run the dishwasher now" — and under a time-of-use plan it varies by hour, which the page
says rather than averaging away.

---

## Banked credits, and the date they stop existing

Under net metering, surplus banks instead of being paid out — and the bank **empties on a
fixed date every year**, 31 March by default. Whatever is left is simply gone. Nothing on a
bill tells you this is coming.

**Settings → the Savings page → Banked credits** tracks it three ways, and keeps them
distinct because they carry different certainty:

**A balance you entered.** A running total predates anything this app has seen, so it
cannot be conjured from flows. One figure off any bill anchors everything below.

**A balance counted from your meter.** Once a usage export is imported (see below), the app
counts forward from that anchor day by day — the same bill, plus everything that has
happened since. It folds day by day rather than netting the period, because a bank does not
go negative: it empties and the rest is bought with money.

**Energy the meter never counted.** Days where the array produced and the meter recorded no
export at all — usually net metering that was not activated yet. That energy is not in the
utility's bank either and never will be, so it is reported separately rather than being
quietly added. On this install that was 367.3 kWh across four days.

Without an anchor the app reports the **change** since the meter data begins and explicitly
refuses to call it a balance. A change presented as a balance is wrong by exactly whatever
was already in the bank.

### What is about to expire

Once there is a balance, the app projects it to the expiry date from your daily meter
readings and says what is at risk — and what extra draw would absorb it, in kilowatt-hours
a day and in hours of charging at your charger's *measured* average power.

It is **advisory and does not command anything**. Drawing power costs money if the
projection is wrong, and it is a projection. It also declines rather than guessing:

- **No balance, no plan.** A trend says which way the bank is going, never how much is in it.
- **Under 25 kWh, it stays quiet.** A projection is not accurate to the kilowatt-hour, and
  sending you to go and use three of them spends your attention on noise.
- **Unmetered days are excluded** from the trend. They net out as pure import, which makes
  the bank look like it is draining faster than it is — wrong in the exact direction that
  would tell you to stop dumping when you should carry on.

---

## Making it measured rather than estimated

Every figure above depends on how much of your production you used yourself rather than
exported. Without a meter that is an estimate — a percentage in Settings — and the app
labels it as one everywhere it appears.

Two things fix that:

**Import your utility's usage export** (Settings → Rates → Utility meter data). Most
utilities publish daily import and export. That is the same boundary a clamp measures,
taken by the meter your bill is calculated from, reaching back to the day the array went
live. Spreadsheet, CSV, or Green Button XML.

**Or fit a CT clamp** on the service entrance, which adds sub-daily resolution and baseload
that a daily export cannot show.

With either, self-consumption stops being typed and starts being measured — and
**Settings → Rates → "Measure that share instead"** will use the measured figure for the
days no meter covers, calibrated to your house rather than to a round number.

The Savings page marks each period as measured or estimated, and says how much of it rests
on which — because a published usage export always lags, so "most of this month is measured
and the last few days are not" is the normal state rather than an edge case.

---

## Related

- [Configuration](configuration.md) — environment variables and endpoints
- [Ask an AI about it](mcp.md) — the MCP server carries measured-vs-estimated and
  kept-vs-forgone into every answer rather than flattening them
