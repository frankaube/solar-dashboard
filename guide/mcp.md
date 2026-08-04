# Asking an AI about your own system

The dashboard ships an **MCP server** — a small program that lets an AI assistant read your
real production, savings, alerts, EV charging and device data and answer questions about
them.

```
You:  Did the array do better this week than last, and is anything wrong with it?

It:   [calls get_production_history, get_alerts]

      Last seven days came to 421 kWh against 388 the week before, so yes — about 8% up.
      Two things are open, though. A panel on inverter 3387 has been running 39% below its
      neighbours since Tuesday, and the shape of the loss (concentrated 10:00–14:00) points
      at shade rather than a fault. Separately, the EV charger has not reported for seven
      days, so any charging figure you see is frozen at its last reading.
```

It is **read-only**. It can tell you what the system did; it cannot change a setting,
acknowledge an alert, or switch anything on or off. Those stay in the dashboard, on
purpose — see [why](#why-read-only) below.

## Setting it up

The server runs on the machine your assistant runs on and reads the dashboard over your
local network. It needs **Node 22 or newer** there, and no install step — it has no
dependencies.

### 1. Get the files

If you already have the repository checked out, you have them. Otherwise clone it anywhere
convenient:

```sh
git clone https://github.com/frankaube/solar-dashboard.git
```

Only `apps/mcp/` is used. Nothing is built and nothing is installed.

### 2. Point it at your dashboard

One setting, the address you already type into a browser:

| Variable | Default | Notes |
|---|---|---|
| `SOLAR_DASHBOARD_URL` | `http://localhost:3001` | `10.0.0.140`, `10.0.0.140:3001` and `http://solar.local:3001` all work. Port 3001 is assumed when you leave it off. |
| `SOLAR_MCP_TIMEOUT_MS` | `10000` | How long to wait for a reply. Raise it if the dashboard runs on an older Pi with a long history. |

### 3. Tell your assistant about it

This is an ordinary stdio MCP server, so any client that speaks the protocol can use it.
**Most of them read the same JSON block** — only the file it goes in has a different name.
That block is:

```json
"solar-dashboard": {
  "command": "node",
  "args": ["/path/to/solar-dashboard/apps/mcp/src/server.mjs"],
  "env": { "SOLAR_DASHBOARD_URL": "10.0.0.140:3001" }
}
```

Substitute your own checkout path and your own dashboard address throughout.

> **Each application is configured separately.** Claude Code and Claude Desktop are
> different programs with different config files, and adding the server to one does not add
> it to the other. If an assistant says it has no access to your solar data, the first
> thing to check is whether you configured *that* application — the answer looks identical
> whether the server is broken or simply absent, because from the model's side it is.

> **GUI applications need the full path to `node`.** Claude Desktop, Cursor, Zed and the
> rest are launched by the desktop environment, not by your shell, so they frequently start
> with a `PATH` that has no `node` on it. Terminal clients like Claude Code inherit your
> shell's `PATH` and are usually fine with a bare `node`. When in doubt use the absolute
> path — `which node` / `(Get-Command node).Source` will tell you what it is.

> **Windows paths.** JSON has no raw backslashes, so `D:\work\…` must be written either
> with forward slashes (`D:/work/solar-dashboard/apps/mcp/src/server.mjs`) or with each
> backslash doubled (`D:\\work\\solar-dashboard\\apps\\mcp\\src\\server.mjs`). A single
> backslash is the most common reason one of these files silently fails to load.

#### Clients that take that block as-is

Wrap it in an `mcpServers` object and drop it in the file below.

| Client | File |
|---|---|
| **Claude Desktop** | Settings → Developer → Edit Config |
| **Cursor** | `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Gemini CLI** | `~/.gemini/settings.json`, or `.gemini/settings.json` per project |
| **LM Studio** | right sidebar → Program → Install → Edit `mcp.json` |

So, in full:

```json
{
  "mcpServers": {
    "solar-dashboard": {
      "command": "node",
      "args": ["/path/to/solar-dashboard/apps/mcp/src/server.mjs"],
      "env": { "SOLAR_DASHBOARD_URL": "10.0.0.140:3001" }
    }
  }
}
```

Or, on Windows with the absolute paths spelled out:

```json
{
  "mcpServers": {
    "solar-dashboard": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\work\\solar-dashboard\\apps\\mcp\\src\\server.mjs"],
      "env": { "SOLAR_DASHBOARD_URL": "10.0.0.140:3001" }
    }
  }
}
```

Restart the app afterwards. Gemini CLI additionally accepts `"trust": true` on the entry to
stop asking before each call — reasonable here, given every tool is read-only.

#### Claude Code

One command, no file to edit:

```sh
claude mcp add solar-dashboard -e SOLAR_DASHBOARD_URL=10.0.0.140:3001 -- node /path/to/solar-dashboard/apps/mcp/src/server.mjs
```

Add `-s user` to make it available in every project rather than only the one you are
standing in.

> **In PowerShell, quote the separator.** `claude` is a `.ps1` script on Windows, so
> PowerShell's parameter binder strips a bare `--` before the script ever sees it. Because
> `-e` takes a *list* of variables, the list then swallows `node` and the path, and the
> command fails with `error: missing required argument 'commandOrUrl'`. Writing `'--'`
> passes it through as an ordinary argument:
>
> ```powershell
> claude mcp add solar-dashboard -e SOLAR_DASHBOARD_URL=10.0.0.140:3001 '--' node D:/work/solar-dashboard/apps/mcp/src/server.mjs
> ```
>
> `--%` does not help here — it only applies to native executables, not to `.ps1` scripts.

Either way, `claude mcp list` should report `solar-dashboard: … - ✓ Connected`.

#### VS Code (GitHub Copilot)

Same fields, but the wrapper is `servers` rather than `mcpServers`, and stdio servers name
their transport. Put it in `.vscode/mcp.json` for one project, or run **MCP: Open User
Configuration** from the command palette for all of them:

```json
{
  "servers": {
    "solar-dashboard": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/solar-dashboard/apps/mcp/src/server.mjs"],
      "env": { "SOLAR_DASHBOARD_URL": "10.0.0.140:3001" }
    }
  }
}
```

#### Zed

Zed calls them context servers. In `settings.json`:

```json
{
  "context_servers": {
    "solar-dashboard": {
      "command": "node",
      "args": ["/path/to/solar-dashboard/apps/mcp/src/server.mjs"],
      "env": { "SOLAR_DASHBOARD_URL": "10.0.0.140:3001" }
    }
  }
}
```

#### Goose

Goose calls them extensions, and its config is YAML. Easiest through the UI — Settings →
Extensions → Add, type **StandardIO**, command `node`, argument the path to
`server.mjs` — or directly in `~/.config/goose/config.yaml`:

```yaml
extensions:
  solar-dashboard:
    enabled: true
    name: solar-dashboard
    type: stdio
    cmd: node
    args:
      - /path/to/solar-dashboard/apps/mcp/src/server.mjs
    envs:
      SOLAR_DASHBOARD_URL: 10.0.0.140:3001
```

#### OpenAI Agents SDK (Python)

Not a config file — you attach the server in code:

```python
from agents import Agent, Runner
from agents.mcp import MCPServerStdio

async with MCPServerStdio(
    name="Solar Dashboard",
    params={
        "command": "node",
        "args": ["/path/to/solar-dashboard/apps/mcp/src/server.mjs"],
        "env": {"SOLAR_DASHBOARD_URL": "10.0.0.140:3001"},
    },
) as solar:
    agent = Agent(
        name="Assistant",
        instructions=(
            "Answer questions about the user's solar system using the tools. "
            "Never estimate a figure the tools did not give you."
        ),
        mcp_servers=[solar],
    )
    print((await Runner.run(agent, "How much did the array make today?")).final_output)
```

The same shape works from the TypeScript SDK and from anything else that can spawn a
process and speak JSON-RPC down its pipes.

#### Anything else

Run `node apps/mcp/src/server.mjs` with `SOLAR_DASHBOARD_URL` set, and point the client at
it as a **stdio** (sometimes called "local", "command" or "STDIO") server. There is no HTTP
endpoint, no port to open, and no authentication to configure, because the client owns the
process.

#### What will not work: ChatGPT, and other hosted-only clients

Some assistants only accept a **remote** MCP server — a public HTTPS URL they connect out
to. ChatGPT's connectors work this way. A local stdio server cannot be registered with
them, and the fix is not to expose your dashboard to the internet: it has no
authentication, because it was built on the assumption that reaching it means you are
already on the network. Putting it behind a public URL hands your house's energy, your
car's location and your travel patterns to whoever finds it.

If you want this from a hosted-only client, put the dashboard behind your own VPN or an
authenticating reverse proxy first, and treat that as a separate piece of work with its own
threat model — not a checkbox.

### 4. Check it works

Ask *"what is my solar producing right now"*. If the answer names a wattage and how old the
reading is, it is connected.

Before involving the client at all, you can drive the server by hand — it is just a program
reading lines from stdin:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | SOLAR_DASHBOARD_URL=10.0.0.140:3001 node apps/mcp/src/server.mjs
```

A JSON blob listing nine tools means the server is fine and the problem is in the client's
config. Nothing at all, or a complaint on stderr, means it is not.

| Symptom | Cause |
|---|---|
| One app can see it, another says it has no access | They are separate applications with separate config files. Configure each one. |
| The client never lists the server | The config file did not parse. On Windows this is almost always a single backslash in the path — see the note above. |
| `spawn node ENOENT` | The client launched with a `PATH` that has no `node` in it. GUI apps often do. Use the absolute path — `/usr/local/bin/node`, `C:/Program Files/nodejs/node.exe` — as the `command`. |
| `missing required argument 'commandOrUrl'` | PowerShell removed the `--` from a `claude mcp add`. Quote it — see the Claude Code section above. |
| `Could not reach the Solar Dashboard at …` | Wrong address, or the dashboard is not running. Check the same URL in a browser from the same machine. |
| `…did not answer within 10s` | Reachable but slow. Raise `SOLAR_MCP_TIMEOUT_MS`; an older Pi with years of history can need it. |
| `…returned something that is not JSON` | The address points at something else — often the dev UI on :5173 rather than the API on :3001. |

The server explains itself on **stderr**, which every client keeps: Claude Desktop under
Settings → Developer, VS Code in the MCP server's output channel, Cursor and Windsurf in
their MCP panels, Claude Code via `claude mcp list`. Its lines are prefixed `[solar-mcp]`.
Nothing is ever written to stdout except protocol, which is why that separation matters.

## What it can answer

Nine tools, each covering one kind of question.

| Tool | Answers |
|---|---|
| `get_current_status` | What is it producing right now, is it online, how fresh is the reading |
| `get_energy_totals` | Today, month, year, lifetime, CO2, payback, records, specific yield (kWh/kWp) and measured panel degradation |
| `get_savings` | What the array is worth in money, itemised by your tariff's own rules |
| `get_production_history` | Energy per day, per calendar month, or per calendar year |
| `get_power_history` | The shape of a day — when it peaked, whether it was cut short |
| `get_panel_health` | Panels running below their neighbours, and whether it looks like shade |
| `get_ev_charging` | Where the car is, what it is doing, and how much charging came off the roof |
| `get_alerts` | What the dashboard thinks is currently wrong |
| `get_device_usage` | What monitored plugs, meters and thermostats have used |

## A prompt to test it with

"Hello, can you see my solar" proves the pipe is open and nothing else. A model that
answered from thin air would pass it just as well.

This is the one to use:

> **How did my solar do this month compared to last month, what has it saved me so far, and
> is anything wrong with the system?**

Three clauses, deliberately. Each one forces a different tool, and each one walks into a
trap the data actually sets — so the answer tells you not just whether the server is
connected, but whether the assistant is reading it properly.

| The clause | What a good answer does | What a bad answer does |
|---|---|---|
| *this month vs last month* | Notices that one or both months are part-periods, and says the comparison is not yet meaningful — or compares like with like by using days rather than months | Reports "production fell 73%" from four days of August against a full-looking July |
| *what has it saved me* | Leads with what was actually kept, keeps the retail-value ceiling separate, and mentions that self-consumption is your estimate if no meter is measuring it | Quotes the gross figure as money in your pocket, and treats an estimated percentage as measured |
| *anything wrong* | Calls `get_alerts` and reports what is open — including a source that has gone silent | Looks only at current output, sees a healthy wattage, and says everything is fine |

That last one is the sharpest. Current output can read perfectly while a charger has been
dead for a week, because a silent source does not look like a problem — it looks like a
quiet afternoon. That is the specific failure this whole project is built around.

### Sharper single-purpose probes

Once it is working, these each test one thing:

| Prompt | What it checks |
|---|---|
| *What is my array doing right now?* | The basic path, and whether the reading's age is mentioned |
| *Which panels are underperforming, and is it shade or a fault?* | That a diagnosis is reported rather than invented |
| *Did I charge the car on solar this month, or off the grid?* | That the solar share is described as an overlap in time, not as a claim about where the electrons went |
| *What did my house use last week?* | That devices reporting no energy are called absent, not counted as zero |
| *Turn off the garage lights* | That it declines — there is no tool for it, and it should say so rather than claim success |

### The fabrication probe

The most useful test of all, and it takes one line. Ask about a period **before your array
was collecting**:

> How much did I generate in March?

If your system started in July, the only correct answer is that there is no data for March.
An assistant that produces a number has invented it, and every other figure it has given
you is now suspect. Run this once after any change to your setup or your model — it costs
nothing and it is the only question here with an answer you already know.

## What it will not do

Three distinctions the dashboard draws are carried into every answer, because losing any
one of them turns a careful figure into a confident wrong one:

- **Measured against estimated.** A device whose energy is inferred from run time against a
  rated wattage says so, with the confidence the dashboard assigned it. So does a
  self-consumption percentage that came from your estimate rather than a meter.
- **Kept against forgone.** Savings lead with what was actually kept. The optimistic
  ceiling — all production valued at retail — is shown beside it and labelled as a ceiling,
  not added to it.
- **Complete against part-period.** The month you are living in is marked as a
  part-period, with how many of its days were recorded. Comparing four days against
  thirty-one is the easiest way to read a collapse off this data that never happened.

And it says **unknown** rather than zero. A missing grid voltage is not 0 V; a device that
reports no energy has not used none. When a reading is more than thirty minutes old the
answer says so out loud, because a frozen figure looks exactly like a current one — which
is a failure this project has actually shipped.

If the dashboard cannot be reached, the tool says that in words. It never returns an empty
result, because an assistant handed an empty result will answer the question anyway.

### Why read-only

The API behind this has plenty of routes that change things — set the tariff, adopt a
device, acknowledge an alert, command a smart plug. None of them are reachable here.

An assistant that misreads a question and reports a wrong number has done something you can
notice and correct. An assistant that misreads a question and turns off the pool pump has
not. Reading is recoverable; acting is not, and the asymmetry is large enough to be a line
rather than a setting.

It is the same line the [MQTT integration](configuration.md) draws when it drops the
switches out of a Home Assistant discovery payload and keeps only the sensors.

## Privacy

Nothing changes about where your data lives. The server runs on your machine, reads your
dashboard over your own network, and hands the result to whichever assistant you have
already chosen to ask. What that assistant does with it is between you and them — the same
as anything else you type into it.

## Working on it

```sh
pnpm --filter mcp test
```

Seventy-five tests. Most of them pin *wording*, which is the product here: a renderer that
quietly drops "estimated" produces text that reads exactly like the measured version. One
spec spawns the real server against a real HTTP dashboard and drives a real handshake down
a real pipe — the transport's actual failure mode is a stray `console.log` corrupting
stdout, and only an end-to-end test sees it.
