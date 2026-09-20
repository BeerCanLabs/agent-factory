# Build the Factory, Not the Agent

If you read my previous post on the "Console vs. Cartridge" architecture, you know the core problem: the industry is sacrificing enterprise security for millisecond cold-starts. By weaving complex orchestration frameworks directly into the agent’s logic, we’ve created monolithic agents that cannot be governed from the outside. 

If an agent goes rogue and starts burning $10,000 an hour, and the infrastructure is baked *into* the agent itself... who pulls the plug?

The solution is to decouple the two. The agent becomes a stateless "Cartridge" of pure reasoning, and the execution engine becomes the "Console."

But how do you actually build an execution engine that governs an agent without crippling its speed?

### The Latency Death Spiral
The strongest argument against strict governance is latency. If your Cartridge has to make a network round-trip to a centralized corporate API Gateway for every single step of its reasoning loop (Think -> Tool -> Parse -> Think), the agent will crawl to a halt. A 5-step loop that takes 2 seconds in a monolith will take 30 seconds behind a traditional API gateway.

You can't govern agents using 2015-era API Gateway patterns. You have to build a modern Factory. 

### 1. The Sidecar Pattern (Zero-Latency Governance)
The Factory does not govern the Cartridge by forcing it to talk to a distant server. It governs the Cartridge using a **Sidecar Proxy** (like Envoy).

When the Factory spins up the Cartridge container, it spins up a tiny, ultra-fast proxy in the exact same network namespace. When the agent code calls Anthropic, OpenAI, or a corporate database, it routes through `localhost`. 

The latency of routing through a sidecar on `localhost` is less than 1 millisecond. The agent executes its high-speed reasoning loops instantly in-memory, but the Factory still maintains absolute, perimeter-level control over every byte that leaves the container. You get monolithic speeds with Cartridge-level security.

### 2. Warm Pools (Killing the Cold Start)
The opposition argues that spinning up a pristine, stateless container takes 30 to 90 seconds, which is unacceptable for real-time use cases. They are right. But "Scale to Zero" is a choice, not a mandate. 

For real-time, user-facing agents (like a customer support bot), the Factory uses **Provisioned Concurrency (Warm Pools)**. The infrastructure keeps a baseline of idle Cartridges running at all times. When a user pings the agent, it connects in milliseconds. As demand spikes, the Factory spins up more in the background.

For background tasks (like an agent that audits Jira tickets overnight), a 90-second cold start costs nothing. Scale it to zero and save the compute.

### 3. Asynchronous Delegation
We have to stop treating enterprise digital workers like chatbots. A chatbot needs to reply in 500 milliseconds. But if you ask an agent to cross-reference 500 GitHub commits against Jira, the task is going to take 5 minutes of compute time. 

A 30-second cold start at the beginning of a 5-minute asynchronous task is irrelevant. The Factory model shifts the UX from *synchronous chatting* to *asynchronous delegation*. The user drops the task in the queue, gets a "Working on it..." acknowledgment instantly, and walks away.

We don't have to choose between speed and security. We just have to architect it correctly.

***
*Up Next in Part 3: Why your agents shouldn't manage their own budgets, and the built-in platform primitives every Factory needs.*
