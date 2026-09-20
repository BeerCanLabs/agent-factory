# Your Agents Shouldn't Manage Budgets (or Secrets)

If you let developers hardcode API keys into an AI agent's codebase, or manage their own `.env` files in production, you instantly fail enterprise security audits. 

In the previous post, we established that the Agent Factory is an execution engine built to strictly separate the agent's reasoning (the Cartridge) from the infrastructure (the Console). But separating the two does more than just solve the vendor lock-in problem. It completely changes the developer experience.

When the Factory handles the heavy lifting, agents no longer need to worry about tracking tokens, managing secrets, or recording audit logs. The Factory provides these as **Built-In Platform Primitives.**

### 1. Identity & Secrets: The Blind Codebase
In the Factory, the agent's code is completely blind to production credentials. 

The enterprise platform team stores the master keys in their existing corporate vault (like AWS Secrets Manager, HashiCorp Vault, or Azure Key Vault). The agent developer simply writes their code to look for a generic variable.

When a user asks the agent to do something, the Factory:
1. Validates the user is authorized (RBAC).
2. Reaches into the corporate vault.
3. Injects a scoped, short-lived key into the Cartridge's memory for the exact lifespan of that execution.

When the agent finishes the task and scales back to zero, the container is destroyed and the key vanishes from memory. 

**The Enterprise Benefit:** The security team can rotate the master OpenAI keys every 15 days in the vault. Because the keys are injected dynamically at runtime, **zero** agents break, and **zero** lines of code need to be redeployed.

### 2. FinOps: The Network Circuit Breaker
Agents shouldn't track their own spending. If an agent hallucinates or gets caught in a reasoning loop, it will easily ignore its own internal cost limits.

In the Factory, the Cartridge makes outbound API calls to LLM providers through the Factory's Sidecar Proxy. The Cartridge doesn't know it's being watched. The Sidecar silently counts every token on the way out and the way back. 

If the agent hits its $50 daily budget, the Factory doesn't politely ask the agent to stop. The Sidecar physically cuts the network connection, halting the agent instantly and firing an alert to IT for a manual budget override.

### 3. The Immutable Ledger
Every token burned, every tool invoked, and every API call made is appended to a Factory-owned execution ledger. 

Because the Sidecar is recording the traffic at the network level, the audit trail is immutable. The agent cannot rewrite or hide its history. If Legal or Compliance needs to know exactly what an agent did and who authorized it to run, the ledger provides a cryptographically secure, SOC2-compliant trail of breadcrumbs.

By pushing Identity, FinOps, and Auditing into the Factory, we completely remove credential management and budget tracking from the business of "building an agent." 

***
*Up Next in Part 4: If the Factory does all the hard work, what does building an agent actually look like?*
