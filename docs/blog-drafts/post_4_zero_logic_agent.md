# The Zero-Logic Agent

We’ve spent the last three posts talking about infrastructure. We’ve covered the Console vs. Cartridge separation, the Sidecar proxies that eliminate cold-start latency, and the Factory primitives that manage secrets and budgets.

Now, let's talk about the payoff. If the Factory handles FinOps, identity, telemetry, and state management... what is actually left for the agent developer to build?

Astonishingly little. We call it the **Zero-Logic Agent**.

Most agent codebases today are bloated. A developer trying to build a simple GitHub-review agent using monolithic frameworks has to write hundreds of lines of code just to handle API keys, manage the context window, configure the vector database, and format the telemetry. The actual "reasoning" is buried under a mountain of boilerplate.

In the Factory model, building a Cartridge takes exactly three things:

### 1. The Surface Manifest (`surface.yaml`)
You don't write code to configure how the agent wakes up; you declare it. The manifest is a simple contract. It tells the Factory: "I need an AWS Bedrock connection, I need permission to use the Jira API, and I can be triggered by a webhook or a Slack message." 

The Factory reads this contract and automatically provisions the serverless compute, the secret bindings, and the event triggers. 

### 2. The Soul (`soul.md`)
This is the system prompt. It is the core identity, rules of engagement, and constraint boundaries for the agent. It is written in plain English (or markdown). You don't need a heavy Python framework to define how an agent should behave; you just need a clearly written text file.

### 3. The Reasoning Loop
Inside the Cartridge container, the agent runs a standard, boring, predictable async loop using raw, foundational LLM SDKs (like the standard Anthropic or OpenAI Python SDK). 

There is no LangChain. There is no AutoGen. 

The loop is simply: *Prompt the model -> Parse the tool call -> Execute the Python script -> Feed the result back to the model -> Repeat until finished.*

### The Ultimate Advantage: Zero-Day Feature Access
Because the Cartridge is just a standard container running a raw SDK, it isn't trapped behind a third-party abstraction layer. 

If Anthropic releases a massive new feature today (like Prompt Caching or Computer Use), a developer using a monolithic framework has to wait weeks for the open-source community to build a wrapper and merge a PR. 

In the Factory, the day a new feature drops, your developer simply updates the `anthropic` package version in their Cartridge's `requirements.txt` and uses it immediately. 

You get the absolute raw power and flexibility of native AI platforms, combined with the airtight enterprise governance of the Factory.

***
*Up Next in Part 5: How to build robust user experiences (Chat, Dashboards, Delegation) without touching a single line of backend Factory code.*
