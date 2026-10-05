# Kingdoms RTS

A hyper-optimized Vite-based RTS game built with deterministic ECS architecture for agentic AI simulation. 

This repository serves as the absolute source of truth for the architecture, designed explicitly to support autonomous agentic workflows, headless CI/CD balancing, and strict lockstep determinism.

## 🏗️ Directory Layout
```text
index.html            Shell: canvas + HUD root + module entry
public/models/        Static 3D models (decoupled from core logic)
public/textures/      Static textures
src/main.ts           Composition root: builds everything, starts the Engine
src/core/             Engine (loop), World (ECS), Pool, Math (Fixed-point). No Three.js/DOM.
src/render/           Renderer (scene/camera), InstancedGroup (army rendering)
src/systems/          One file per system: Movement, Combat, Gather, Production
src/ai/               NavGrid (chunked flow fields), unitStates (FSM)
src/input/            InputController (pointer to FSM-driven UI modes)
src/data/             factions.ts, units.ts, buildings.ts: pure data tables
src/ui/               HUD/DOM widgets; reads World, never mutates it directly
