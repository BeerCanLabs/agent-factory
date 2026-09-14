import http from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import WebSocket from 'ws';

const GARRISON_URL = process.env.GARRISON_URL || 'http://localhost:3001';
const GARRISON_WS = process.env.GARRISON_WS || GARRISON_URL.replace(/^http/, 'ws') + '/ws';
const AGENT_ID = process.env.AGENT_ID || 'hermes-01';
const AGENT_NAME = process.env.AGENT_NAME || 'Hermes Core';
const AGENT_SECTOR = process.env.AGENT_SECTOR || 'sector-eng';
const AGENT_ROLE = process.env.AGENT_ROLE || 'Autonomous Research Agent';
const AGENT_MODEL = process.env.AGENT_MODEL || 'hermes-3-llama-3.1-70b';
const AGENT_PROVIDER = process.env.AGENT_PROVIDER || 'local';
const AGENT_CMD = process.env.AGENT_CMD || '';
const PORT = parseInt(process.env.PORT || '9090', 10);

let state: 'IDLE' | 'WORKING' | 'PAUSED' | 'BLOCKED_FOR_HUMAN' | 'ISOLATED' | 'ERROR' = 'IDLE';
let currentTpm = 450;
let childProcess: ChildProcess | null = null;
let ws: WebSocket | null = null;

console.log(`[Garrison Sidecar] Initializing for Agent: ${AGENT_NAME} (${AGENT_ID})`);
console.log(`[Garrison Sidecar] Garrison C2 Target: ${GARRISON_URL}`);

// 1. Post Log to Garrison
async function sendLog(message: string, level: 'info' | 'warn' | 'error' = 'info') {
  try {
    await fetch(`${GARRISON_URL}/api/v1/agents/${AGENT_ID}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, level }),
    });
  } catch (err) {
    // Suppress transient logging error
  }
}

// 2. Connect WebSocket to Garrison C2 Highway
function connectWebSocket() {
  console.log(`[Garrison Sidecar] Connecting to WebSocket Highway: ${GARRISON_WS}`);
  try {
    ws = new WebSocket(GARRISON_WS);

    ws.on('open', () => {
      console.log(`[Garrison Sidecar] Connected to Garrison C2 WebSocket.`);
      sendLog(`[Garrison Sidecar] Online and connected to C2 command deck.`);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.type === 'AGENT_COMMAND' && payload.agentId === AGENT_ID) {
          handleC2Command(payload.command, payload.args);
        }
      } catch {
        // Ignore unparseable frames
      }
    });

    ws.on('close', () => {
      console.log(`[Garrison Sidecar] C2 WebSocket disconnected. Reconnecting in 5s...`);
      setTimeout(connectWebSocket, 5000);
    });

    ws.on('error', (err) => {
      console.error(`[Garrison Sidecar] C2 WebSocket error:`, err.message);
    });
  } catch (e: any) {
    console.error(`[Garrison Sidecar] Failed to create WebSocket:`, e.message);
    setTimeout(connectWebSocket, 5000);
  }
}

// 3. Handle C2 Tactical Commands from Garrison
function handleC2Command(command: string, args?: any) {
  console.log(`[Garrison Sidecar] Received C2 Command: ${command}`, args || '');
  sendLog(`[C2 ACTION] Executed ${command} command from Garrison console.`);

  switch (command) {
    case 'PAUSE':
      state = 'PAUSED';
      if (childProcess && !childProcess.killed) {
        childProcess.kill('SIGSTOP');
      }
      break;

    case 'RESUME':
      state = 'IDLE';
      if (childProcess && !childProcess.killed) {
        childProcess.kill('SIGCONT');
      }
      break;

    case 'ISOLATE':
      state = 'ISOLATED';
      if (childProcess && !childProcess.killed) {
        childProcess.kill('SIGSTOP');
      }
      break;

    case 'TERMINATE':
      state = 'ERROR';
      if (childProcess) {
        childProcess.kill('SIGKILL');
      }
      break;
  }
}

// 4. Send Periodic Heartbeat to Garrison
async function sendHeartbeat() {
  const memoryUsageMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
  const payload = {
    agentId: AGENT_ID,
    name: AGENT_NAME,
    sectorId: AGENT_SECTOR,
    role: AGENT_ROLE,
    model: AGENT_MODEL,
    provider: AGENT_PROVIDER,
    state,
    metrics: {
      tokensPerMinute: state === 'WORKING' ? currentTpm : 0,
      memoryUsageMb,
      cpuPercent: Math.floor(Math.random() * 20) + 5,
    },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(`${GARRISON_URL}/api/v1/agents/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // If agent not registered, attempt auto-registration
      if (res.status === 404) {
        await registerAgent();
      }
    }
  } catch {
    // Garrison may be temporarily starting up
  }
}

async function registerAgent() {
  try {
    await fetch(`${GARRISON_URL}/api/v1/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: AGENT_NAME,
        role: AGENT_ROLE,
        sectorId: AGENT_SECTOR,
        provider: AGENT_PROVIDER,
        serviceUrl: `http://localhost:${PORT}`,
        model: AGENT_MODEL,
        monthlyBudget: 1500,
      }),
    });
  } catch {
    // Ignore registration retry failure
  }
}

// 5. Spawn Managed Agent Worker (if specified)
function startAgentProcess() {
  if (!AGENT_CMD) {
    console.log(`[Garrison Sidecar] No AGENT_CMD specified. Running in standalone telemetry mode.`);
    return;
  }

  console.log(`[Garrison Sidecar] Spawning agent process: ${AGENT_CMD}`);
  const [cmd, ...args] = AGENT_CMD.split(' ');
  childProcess = spawn(cmd, args, {
    env: { ...process.env },
    shell: true,
  });

  state = 'WORKING';

  childProcess.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[AGENT OUT] ${text}`);
    sendLog(text.trim(), 'info');
  });

  childProcess.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    process.stderr.write(`[AGENT ERR] ${text}`);
    sendLog(text.trim(), 'warn');
  });

  childProcess.on('exit', (code) => {
    console.log(`[Garrison Sidecar] Agent process exited with code ${code}`);
    state = code === 0 ? 'IDLE' : 'ERROR';
    sendLog(`[Garrison Sidecar] Agent process terminated with exit code ${code}`, code === 0 ? 'info' : 'error');
  });
}

// 6. Local Health Check & Discovery HTTP Server (for ECS / Cloud Run / K8s probes & Garrison discovery)
const server = http.createServer((req, res) => {
  // Healthcheck endpoints
  if (req.url === '/healthz' || req.url === '/' || req.url === '/api/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      state,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Garrison standard agent discovery endpoints
  if (req.url === '/api/v1/agents' || req.url === '/v1/mcp/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      {
        id: AGENT_ID,
        name: AGENT_NAME,
        role: AGENT_ROLE,
        domain: AGENT_SECTOR.replace(/^sector-/, ''),
        sectorId: AGENT_SECTOR,
        model: AGENT_MODEL,
        provider: AGENT_PROVIDER,
        state,
        tools: ['core-exec', 'garrison-c2', 'telemetry']
      }
    ]));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Garrison Sidecar] Health check listener ready on http://0.0.0.0:${PORT}/healthz`);
  connectWebSocket();
  startAgentProcess();
  setInterval(sendHeartbeat, 4000);
});
