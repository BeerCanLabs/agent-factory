export const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Agent Factory Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  <style>
    [v-cloak] { display: none; }
    .fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
    .fade-enter-from, .fade-leave-to { opacity: 0; }
    .slide-enter-active, .slide-leave-active { transition: transform 0.3s ease; }
    .slide-enter-from { transform: translateX(100%); }
    .slide-leave-to { transform: translateX(100%); }
  </style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen overflow-x-hidden font-sans">
  <div id="app" v-cloak class="max-w-7xl mx-auto p-4 md:p-6 lg:p-8">
    <header class="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 border-b border-slate-700 pb-4">
      <div>
        <h1 class="text-3xl font-bold text-emerald-400 tracking-tight">Agent Factory</h1>
        <p class="text-slate-400 text-sm mt-1">UAT Dashboard & Control Plane</p>
      </div>
      <div class="flex items-center space-x-6 mt-4 md:mt-0">
        <button @click="showStudio = true" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-md text-sm font-bold shadow-sm transition flex items-center space-x-2">
          <span>+ Create Cartridge</span>
        </button>
        <div class="h-6 w-px bg-slate-700"></div>
        <div class="text-right">
          <p class="text-xs text-slate-500 uppercase tracking-wider font-semibold">Ledger WORM</p>
          <div class="flex items-center space-x-2">
            <span class="w-2 h-2 rounded-full" :class="ledgerHealthy ? 'bg-emerald-400' : 'bg-amber-400'"></span>
            <span class="text-sm font-medium" :class="ledgerHealthy ? 'text-emerald-400' : 'text-amber-400'">
              {{ ledgerStatus }}
            </span>
          </div>
        </div>
        <button @click="verifyLedger" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-md text-sm border border-slate-600 transition shadow-sm font-medium text-slate-200">
          Verify WORM
        </button>
      </div>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-4 gap-8">
      
      <!-- Agents Overview -->
      <div class="lg:col-span-3 space-y-6">
        <div class="flex justify-between items-end border-b border-slate-700 pb-2">
          <h2 class="text-xl font-semibold text-slate-200">Deployed Cartridges</h2>
          <span class="text-xs text-slate-500">Infrastructure-as-Code definitions</span>
        </div>
        
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          <div v-for="agent in agents" :key="agent.id" 
               @click="openAgentPanel(agent)"
               class="bg-slate-800 rounded-xl p-5 border border-slate-700 hover:border-emerald-500 hover:shadow-emerald-900/20 hover:shadow-xl transition cursor-pointer flex flex-col h-full group">
            <div class="flex justify-between items-start mb-3">
              <h3 class="text-lg font-bold text-blue-300 group-hover:text-emerald-400 transition">{{ agent.name }}</h3>
              <div class="flex items-center space-x-2 bg-slate-900 px-2 py-1 rounded-md border border-slate-700">
                <span class="inline-block w-2 h-2 rounded-full" :class="agent.state === 'IDLE' ? 'bg-slate-500' : 'bg-emerald-500 animate-pulse'"></span>
                <span class="text-[10px] uppercase font-bold tracking-wider" :class="agent.state === 'IDLE' ? 'text-slate-400' : 'text-emerald-400'">{{ agent.state }}</span>
              </div>
            </div>
            
            <p class="text-sm text-slate-400 flex-1 line-clamp-3">{{ agent.role }}</p>
            
            <div class="mt-4 pt-3 border-t border-slate-700 flex justify-between items-center text-xs text-slate-500 font-mono">
              <span>{{ agent.id }}</span>
              <span class="text-blue-400 opacity-0 group-hover:opacity-100 transition">View Console &rarr;</span>
            </div>
          </div>
        </div>
      </div>

      <!-- MCP Panel -->
      <div class="space-y-6">
        <div class="bg-slate-800 rounded-xl p-5 border border-slate-700 shadow-lg">
          <h2 class="text-lg font-semibold mb-3 border-b border-slate-700 pb-2 text-slate-200">Headless MCP</h2>
          <p class="text-xs text-slate-400 mb-4"><code>claude code</code>, <code>grok</code>, or <code>agy</code> can interact via <strong>/mcp</strong></p>
          
          <div class="space-y-2 max-h-[500px] overflow-y-auto pr-1">
            <div v-for="tool in mcpTools" :key="tool.name" class="bg-slate-900 rounded p-2.5 border border-slate-700">
              <code class="text-emerald-400 text-xs font-bold">{{ tool.name }}</code>
              <p class="text-[10px] text-slate-500 mt-1 leading-tight line-clamp-2">{{ tool.description }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Agent Modal/Slideoff Panel -->
    <transition name="fade">
      <div v-if="selectedAgent" class="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-sm" @click="closeAgentPanel"></div>
    </transition>
    
    <transition name="slide">
      <div v-if="selectedAgent" class="fixed top-0 right-0 h-full w-full md:w-[600px] lg:w-[800px] bg-slate-900 border-l border-slate-700 z-50 shadow-2xl flex flex-col">
        <!-- Panel Header -->
        <div class="p-6 border-b border-slate-700 bg-slate-800/50 flex justify-between items-start">
          <div>
            <div class="flex items-center space-x-3 mb-1">
              <h2 class="text-2xl font-bold text-emerald-400">{{ selectedAgent.name }}</h2>
              <span class="px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide border" 
                    :class="selectedAgent.state === 'IDLE' ? 'bg-slate-800 text-slate-400 border-slate-700' : 'bg-emerald-900/30 text-emerald-400 border-emerald-800'">
                {{ selectedAgent.state }}
              </span>
            </div>
            <p class="text-sm text-slate-400">{{ selectedAgent.role }}</p>
            <p class="text-xs text-slate-500 font-mono mt-2">ID: {{ selectedAgent.id }}</p>
          </div>
          <button @click="closeAgentPanel" class="text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-md p-2 transition">
            Close
          </button>
        </div>

        <!-- Panel Body: Split between Tasking and History -->
        <div class="flex-1 overflow-y-auto p-6 space-y-8">
          
          <!-- Task Input -->
          <div class="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-inner">
            <div class="bg-slate-900/50 px-4 py-3 border-b border-slate-700 flex justify-between items-center">
              <h3 class="text-sm font-semibold text-slate-300">New Task / Prompt</h3>
            </div>
            <div class="p-4">
              <textarea v-model="newTaskPrompt" rows="3" 
                        class="w-full bg-slate-900 border border-slate-600 rounded-lg p-3 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition text-slate-200 placeholder-slate-500" 
                        placeholder="Describe the task you want this cartridge to perform..."></textarea>
              <div class="mt-3 flex justify-between items-center">
                <div class="text-xs text-slate-500 flex items-center space-x-2">
                  <input type="checkbox" id="rawJsonMode" v-model="rawJsonMode" class="rounded border-slate-600 bg-slate-900 text-emerald-500">
                  <label for="rawJsonMode">Send as raw JSON object</label>
                </div>
                <button @click="submitTask" :disabled="isTasking" 
                        class="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-bold shadow-lg transition flex items-center space-x-2">
                  <span>{{ isTasking ? 'Waking...' : 'Execute Task' }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Run History for Agent -->
          <div>
            <h3 class="text-sm font-semibold text-slate-300 mb-4 uppercase tracking-wider">Run History</h3>
            
            <div v-if="agentRuns.length === 0" class="text-center py-8 bg-slate-800/30 rounded-xl border border-slate-700/50 border-dashed">
              <p class="text-slate-500 text-sm">No tasks executed yet.</p>
            </div>
            
            <div class="space-y-4">
              <div v-for="run in agentRuns" :key="run.runId" class="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
                <div class="px-4 py-3 border-b border-slate-700 bg-slate-900/30 flex justify-between items-center cursor-pointer hover:bg-slate-900/50 transition" @click="run.expanded = !run.expanded">
                  <div class="flex items-center space-x-3">
                    <div class="w-2 h-2 rounded-full" 
                         :class="{
                           'bg-emerald-400': run.state === 'DONE',
                           'bg-amber-400 animate-pulse': run.state === 'RUNNING',
                           'bg-red-400': run.state === 'FAILED'
                         }"></div>
                    <span class="text-sm font-mono text-slate-300">{{ run.runId.substring(0,8) }}</span>
                    <span class="text-xs text-slate-500">{{ new Date(run.createdAt).toLocaleTimeString() }}</span>
                  </div>
                  <div class="flex items-center space-x-3">
                    <span class="text-xs font-bold uppercase" 
                          :class="{
                            'text-emerald-400': run.state === 'DONE',
                            'text-amber-400': run.state === 'RUNNING',
                            'text-red-400': run.state === 'FAILED'
                          }">{{ run.state }}</span>
                  </div>
                </div>
                
                <div v-if="run.expanded" class="p-4 space-y-4 bg-slate-900/10">
                  <div v-if="run.input" class="bg-slate-900 p-3 rounded-lg border border-slate-800">
                    <p class="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">Input</p>
                    <pre class="text-sm text-blue-300 whitespace-pre-wrap font-mono">{{ typeof run.input === 'string' ? run.input : JSON.stringify(run.input, null, 2) }}</pre>
                  </div>
                  
                  <div v-if="run.result" class="bg-slate-900 p-3 rounded-lg border border-slate-800">
                    <p class="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">Output</p>
                    <pre class="text-sm text-emerald-300 whitespace-pre-wrap font-mono">{{ typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2) }}</pre>
                  </div>

                  <div v-if="run.error" class="bg-red-900/20 p-3 rounded-lg border border-red-900/50">
                    <p class="text-xs font-semibold text-red-400 mb-1 uppercase tracking-wide">Error</p>
                    <p class="text-sm text-red-300 font-mono">{{ run.error }}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
        </div>
      </div>
    </transition>

    <!-- Cartridge Studio Modal -->
    <transition name="fade">
      <div v-if="showStudio" class="fixed inset-0 z-[100] bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4">
        <div class="bg-slate-800 border border-slate-600 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
          <div class="p-6 border-b border-slate-700 flex justify-between items-center bg-slate-900/50">
            <div>
              <h2 class="text-2xl font-bold text-blue-400">Cartridge Studio</h2>
              <p class="text-slate-400 text-sm">Generate Agent Boilerplate</p>
            </div>
            <button @click="showStudio = false" class="text-slate-400 hover:text-white transition">Close</button>
          </div>
          
          <div class="p-6 overflow-y-auto space-y-6">
            <div v-if="!generatedScript">
              <div class="space-y-4">
                <div>
                  <label class="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1">Agent ID</label>
                  <input v-model="studioId" type="text" placeholder="my-new-agent" class="w-full bg-slate-900 border border-slate-600 rounded p-3 text-slate-200 focus:border-blue-500 focus:outline-none font-mono text-sm">
                </div>
                <div>
                  <label class="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1">Display Name</label>
                  <input v-model="studioName" type="text" placeholder="Data Analyst" class="w-full bg-slate-900 border border-slate-600 rounded p-3 text-slate-200 focus:border-blue-500 focus:outline-none text-sm">
                </div>
                <div>
                  <label class="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1">Role / Description</label>
                  <textarea v-model="studioRole" rows="2" placeholder="Analyzes raw JSON data and extracts insights." class="w-full bg-slate-900 border border-slate-600 rounded p-3 text-slate-200 focus:border-blue-500 focus:outline-none text-sm"></textarea>
                </div>
              </div>
              <button @click="generateCartridge" :disabled="!studioId" class="mt-6 w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold rounded-lg transition">
                Generate Scaffold Script
              </button>
            </div>
            
            <div v-else>
              <div class="bg-emerald-900/20 border border-emerald-800 rounded-lg p-4 mb-4">
                <h3 class="text-emerald-400 font-bold mb-1">Cartridge Generated</h3>
                <p class="text-sm text-emerald-300/70">Run this script in the root of your <code>agent-factory</code> repository to inject the new cartridge into the infrastructure.</p>
              </div>
              <div class="relative group">
                <pre class="bg-slate-950 p-4 rounded-lg border border-slate-700 text-xs text-blue-300 font-mono overflow-x-auto whitespace-pre">{{ generatedScript }}</pre>
                <button @click="copyScript" class="absolute top-2 right-2 px-3 py-1 bg-slate-800 border border-slate-600 text-slate-300 text-xs rounded hover:bg-slate-700 transition opacity-0 group-hover:opacity-100">
                  {{ copyText }}
                </button>
              </div>
              <button @click="generatedScript = null" class="mt-4 text-sm text-slate-400 hover:text-white underline">Start Over</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

  </div>

  <script>
    const { createApp, ref, computed, onMounted } = Vue;
    
    let token = new URLSearchParams(window.location.search).get("token") || localStorage.getItem("factory_token");
    if (!token) {
      token = prompt("Enter your Factory Admin Token:");
      localStorage.setItem("factory_token", token);
    }
    const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };

    createApp({
      setup() {
        const agents = ref([]);
        const mcpTools = ref([]);
        const allRuns = ref([]);
        
        const selectedAgent = ref(null);
        const newTaskPrompt = ref("");
        const rawJsonMode = ref(false);
        const isTasking = ref(false);
        
        const ledgerStatus = ref("Unknown");
        const ledgerHealthy = ref(false);
        
        const showStudio = ref(false);
        const studioId = ref("");
        const studioName = ref("");
        const studioRole = ref("");
        const generatedScript = ref(null);
        const copyText = ref("Copy");

        const agentRuns = computed(() => {
          if (!selectedAgent.value) return [];
          return allRuns.value.filter(r => r.agentId === selectedAgent.value.id);
        });

        const fetchAgents = async () => {
          try {
            const res = await fetch("/api/v1/agents", { headers });
            if (res.status === 401) { localStorage.removeItem("factory_token"); alert("Invalid token, refresh."); return; }
            agents.value = await res.json();
          } catch(e) { console.error(e); }
        };

        const fetchMcpTools = async () => {
          try {
            const res = await fetch("/mcp", {
              method: "POST", headers,
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
            });
            const data = await res.json();
            if (data.result && data.result.tools) mcpTools.value = data.result.tools;
          } catch(e) { console.error(e); }
        };

        const verifyLedger = async () => {
          ledgerStatus.value = "Verifying...";
          ledgerHealthy.value = false;
          try {
            const res = await fetch("/api/v1/ledger/verify", { headers });
            const data = await res.json();
            if (data.ok && data.worm) {
              ledgerStatus.value = "Verified (" + data.checkpointsChecked + " ckpts)";
              ledgerHealthy.value = true;
            } else {
              ledgerStatus.value = "Verification Failed";
            }
          } catch(e) { 
            ledgerStatus.value = "Error";
          }
        };

        const openAgentPanel = (agent) => {
          selectedAgent.value = agent;
          newTaskPrompt.value = "";
          fetchRuns();
        };

        const closeAgentPanel = () => {
          selectedAgent.value = null;
        };

        const fetchRuns = async () => {
          try {
            const res = await fetch("/api/v1/runs", { headers });
            const data = await res.json();
            const newRuns = [];
            for (const r of data) {
              const existing = allRuns.value.find(e => e.runId === r.runId);
              newRuns.push({ ...r, expanded: existing ? existing.expanded : false });
            }
            allRuns.value = newRuns;
          } catch(e) { console.error(e); }
        };

        const submitTask = async () => {
          if (!selectedAgent.value || !newTaskPrompt.value.trim()) return;
          isTasking.value = true;
          
          try {
            let payload;
            if (rawJsonMode.value) {
              try { payload = JSON.parse(newTaskPrompt.value); } 
              catch(e) { alert("Invalid JSON format"); isTasking.value = false; return; }
            } else {
              payload = { text: newTaskPrompt.value };
            }

            const res = await fetch("/api/v1/agents/" + selectedAgent.value.id + "/runs", {
              method: "POST", headers,
              body: JSON.stringify({ input: payload })
            });
            const data = await res.json();
            
            data.expanded = true;
            allRuns.value.unshift(data);
            newTaskPrompt.value = "";
            pollRun(data.runId);
            fetchAgents();
          } catch(e) { 
            alert("Failed to start run: " + e.message); 
          }
          isTasking.value = false;
        };
        
        const pollRun = async (runId) => {
          const interval = setInterval(async () => {
            try {
              const res = await fetch("/api/v1/runs/" + runId, { headers });
              const data = await res.json();
              const runIndex = allRuns.value.findIndex(r => r.runId === runId);
              if (runIndex !== -1) {
                data.expanded = allRuns.value[runIndex].expanded;
                allRuns.value[runIndex] = data;
              }
              if (["DONE", "FAILED", "TIMED_OUT"].includes(data.state)) {
                clearInterval(interval);
                fetchAgents();
              }
            } catch(e) { clearInterval(interval); }
          }, 2000);
        };

        const generateCartridge = () => {
          const id = studioId.value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
          
          const script = \`#!/usr/bin/env bash
set -e
ID="\\\${1:-\${id}}"
mkdir -p agents/$ID
cat << 'CART' > agents/$ID/surface.yaml
triggers:
  - type: http
    path: /wake
kind: oci
ref: oci://ghcr.io/beercanlabs/factory-agent-$ID:latest
localCommand: [node, worker.mjs]
CART
cat << 'CART' > agents/$ID/worker.mjs
#!/usr/bin/env node
const { FACTORY_URL, FACTORY_RUN_ID, FACTORY_RUN_TOKEN } = process.env;
const run = \\\`\\\${FACTORY_URL.replace(/\\/$/, '')}/api/v1/runs/\\\${FACTORY_RUN_ID}\\\`;
const auth = { Authorization: \\\`Bearer \\\${FACTORY_RUN_TOKEN}\\\`, 'Content-Type': 'application/json' };
const { input } = await (await fetch(\\\`\\\${run}/input\\\`, { headers: auth })).json();

// TODO: Replace with actual agent logic
const output = \\\`Processed: \\\${input?.text || JSON.stringify(input)}\\\`;

await fetch(\\\`\\\${run}/result\\\`, { 
  method: 'POST', 
  headers: auth, 
  body: JSON.stringify({ status: 'succeeded', output }) 
});
CART
cat << 'CART' > agents/$ID/soul.md
prefix: $ID
# Soul: \${studioName.value || id}
## Identity & Role
- **Default Title:** \${studioName.value || id}
- **Mandate:** \${studioRole.value || 'Generic agent cartridge.'}
CART

# Inject into aws-deploy.sh AGENTS_JSON map
sed -i '' 's/"llm-summarizer":{"image":"%s\\/factory-agent-llm-summarizer:%s"}}'/"llm-summarizer":{"image":"%s\\/factory-agent-llm-summarizer:%s"},"'$ID'":{"image":"%s\\/factory-agent-'$ID':%s"}}'/g' scripts/aws-deploy.sh
# Inject docker build command
sed -i '' '/factory-agent-llm-summarizer/a\\
build "$ROOT/runtimes/generic/Dockerfile" factory-agent-'$ID' '$ID'
' scripts/aws-deploy.sh

echo "Cartridge $ID generated successfully!"
echo "Run ./scripts/aws-deploy.sh to push the new agent to AWS."\`;
          
          generatedScript.value = script;
        };
        
        const copyScript = async () => {
          await navigator.clipboard.writeText(generatedScript.value);
          copyText.value = "Copied!";
          setTimeout(() => { copyText.value = "Copy"; }, 2000);
        };

        onMounted(() => {
          fetchAgents();
          fetchMcpTools();
          verifyLedger();
          fetchRuns();
          setInterval(() => { fetchAgents(); fetchRuns(); }, 5000);
        });

        return {
          agents, mcpTools, allRuns, agentRuns,
          selectedAgent, newTaskPrompt, rawJsonMode, isTasking,
          ledgerStatus, ledgerHealthy, 
          verifyLedger, openAgentPanel, closeAgentPanel, submitTask,
          showStudio, studioId, studioName, studioRole, generatedScript,
          generateCartridge, copyScript
        };
      }
    }).mount("#app");
  </script>
</body>
</html>`;
