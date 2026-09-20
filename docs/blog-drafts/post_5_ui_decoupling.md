# Decoupling the Chat Window from the AI

The AI industry is currently suffering from a massive chatbot hangover. 

Because ChatGPT was the breakthrough product, the market has inherently assumed that *Agent = Chat Window*. Platforms tightly couple the agent's reasoning to a specific conversational UI, making it incredibly difficult to trigger those agents from background jobs or enterprise systems.

The Agent Factory rejects this. The Factory is a strictly headless infrastructure engine. It does not have a mandatory dashboard, and its agents do not have mandatory chat windows. 

Instead, the Factory exposes four strictly documented interfaces (the "ports" on the Console). By decoupling the UI from the execution engine, frontend designers can build incredibly robust user experiences without ever touching a single line of backend Factory code.

### The Four Factory Interfaces

If you are building a UI or an external system that interacts with the Factory, you will use these four interfaces to orchestrate the UX:

#### 1. The Synchronous API (The "Walkie-Talkie")
*Use this when the UI needs an immediate, transactional answer to proceed.*
A standard REST API has zero memory. Every request is a completely isolated event. A frontend React app will use this interface to quickly configure the factory: `POST`ing a new agent manifest to the registry, querying the current token spend to render a FinOps dashboard, or checking which agents a specific user is authorized to invoke. 

#### 2. Webhooks (The "Call Me Back")
*Use this when the UI delegates a heavy, long-running task.*
We have to stop treating digital workers like chatbots. If you ask an agent to audit a 50-page PDF, it will take 5 minutes. The UI shouldn't hang and display a loading spinner. Instead, the UI submits the task to the Factory via webhook. The Factory instantly replies with `202 Accepted` and hangs up. 10 minutes later, the Factory `POST`s the completed audit report back to the UI's backend. The UX shifts from synchronous chatting to asynchronous delegation.

#### 3. WebSockets (The "Stay on the Phone")
*Use this when the UI requires a live, continuous, bidirectional stream of data.*
If you *do* want to build a ChatGPT-style interface, you need a pipe that stays open. The UI connects to the Factory via WebSocket. The Factory streams the Cartridge's active execution token-by-token back to the user. This is also how developers can open a "Live Console" in the UI to watch an agent's internal thoughts (chain-of-thought) in real-time, or how an agent can stream a request to a human for immediate approval to drop a database table.

#### 4. Events / Pub-Sub (The "Text Message")
*Use this for background automation and immutable telemetry exhaust.*
Events are fire-and-forget. The UI doesn't necessarily invoke them, but the enterprise data lake (Datadog/Splunk) relies on them. As the agent runs, the Factory fires thousands of micro-events ("Token Burned," "Tool Executed") onto a queue. This allows the enterprise to build massive historical dashboards of agent behavior without blocking or slowing down the agent's execution loop.

***

By treating the Factory as a headless engine with fixed, documented ports, you completely decouple the backend infrastructure from the frontend experience. 

You build the execution engine once. You let developers drop in simple, zero-logic Cartridges. And you let UX designers plug into the ports to build exactly the interfaces the business needs. That is how you scale enterprise AI.
