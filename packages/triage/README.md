# Factory Kernel Module: Triage

This module is part of the core Factory infrastructure (Console). It is a deterministic worker, not a Cartridge.

## Purpose
It consumes unified infrastructure and application errors from the Ledger and EventBridge (e.g., OOM crashes, non-zero exits). 

It formats these crash logs and routes them to external observability dashboards, ITSM alerting tools, or Slack webhooks, allowing operators to rapidly diagnose unhealthy agents.
