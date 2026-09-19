# Factory Kernel Module: Budget

This module is part of the core Factory infrastructure (Console). It is a deterministic worker, not a Cartridge.

## Purpose
It aggregates the immutable ledger exhaust produced by the `gateway`. It tallies token counts and calculates real-time spend across the fleet.

## Circuit Breakers
If an agent exceeds its daily budget threshold (configured via `PUT /api/v1/agents/:id/policy`), this module will call the Control Plane to execute a hard stop on that agent's tasks and block its future proxy egress.
