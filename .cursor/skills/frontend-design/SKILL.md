---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use when building or styling web UI (components, pages, dashboards, landing pages, posters, HTML/CSS layouts, React/Vue/Svelte apps) and when beautifying or redesigning any frontend to avoid generic “AI slop” aesthetics.
---

# Frontend Design Skill

Create distinctive, production-grade frontend interfaces with intentional aesthetics and meticulous craft. The goal is not “pretty”; it is **memorable** and **cohesive**, while remaining functional, accessible, and shippable.

## Operating Rules (non-negotiable)

- **Pick a bold direction before writing code**: commit to a specific aesthetic with a clear reason.
- **Avoid generic AI aesthetics**: no predictable component templates, no cliché palettes, no default “SaaS gradient” look, no overused design recipes.
- **Ship working code**: implement real UI (not mock-only) that can run in the user’s stack.
- **Match complexity to vision**:
  - Maximalist: layered visuals, motion choreography, rich states.
  - Minimalist: ruthless restraint, type/spacing precision, subtle texture.
- **Prefer coherence over novelty**: every choice should support the concept.

## Design Thinking (do this first)

Answer these quickly and explicitly, then start coding.

- **Purpose**: what problem does this UI solve and for whom?
- **Tone**: choose one extreme and stick to it:
  - brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined,
    playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric,
    soft/pastel, industrial/utilitarian, etc.
- **Constraints**: framework, performance budgets, accessibility, browser support, theming, i18n, responsiveness.
- **Differentiation**: what is the one detail users will remember (layout move, type choice, motion moment, texture, interaction)?

Then produce a **one-sentence concept**:

> “This interface feels like ______ because ______.”

Use that sentence as the consistency check for every decision.

## Aesthetic Execution Checklist

### Typography

- Use **characterful** font choices. Avoid generic families (Arial/Roboto/Inter/system defaults).
- Pair a **distinct display face** with a **refined reading face**.
- Use type as structure: scale, tracking, optical size (if available), and rhythm.
- Ensure accessible contrast, legible sizes, and sensible line length.

### Color & Theme

- Define a **tight palette** with a dominant base and sharp accents.
- Use **CSS variables** and tokens so the theme is coherent and maintainable.
- Avoid timid “evenly spread” color use; commit to hierarchy.

### Spatial Composition

- Prefer interesting layout moves: asymmetry, overlap, diagonal flow, grid breaks, controlled density or generous negative space.
- Build responsive behavior intentionally (not “everything just stacks”).

### Motion

- Choreograph **one high-impact moment** (page load / section reveal) with staggered delays.
- Add micro-interactions only where they matter (hover, focus, selected states).
- Prefer CSS-only when appropriate; if React animation libraries are already in the project, use them consistently.
- Never let motion harm usability: respect reduced motion preferences.

### Backgrounds & Visual Detail

- Add atmosphere: texture, grain/noise, mesh gradients, patterns, layered translucency, dramatic shadow logic, bespoke borders, or custom cursors—only if it supports the concept.
- Avoid default “flat card on gray background” unless the concept is intentionally austere.

## Implementation Expectations

When implementing a UI request:

- **Ask for nothing** unless truly required; infer sensible defaults from context.
- **Use the project’s stack** (React, Vite, Next, plain HTML, etc.) and existing conventions.
- **Create reusable tokens**: CSS variables (and optionally a small theme object) for spacing, radius, color, elevation, typography.
- **Accessibility**:
  - Semantic HTML, keyboard navigation, focus-visible styling, ARIA only when necessary.
  - Respect `prefers-reduced-motion`.
  - Maintain contrast and readable sizes.
- **Performance**:
  - Keep effects efficient (avoid heavy filters everywhere).
  - Use gradients, shadows, and transforms thoughtfully.

## Anti-Patterns to Avoid

- Overused “AI UI” patterns (cookie-cutter SaaS cards, generic hero + 3 features, predictable pills everywhere).
- Cliché palettes (especially purple-on-white gradients and safe blue accents without intent).
- Reusing the same trendy fonts repeatedly across generations.
- Repetitive spacing, identical border radii, and “everything is the same size” visual monotony.
- Fancy visuals without interaction states and accessibility.

## Output Format

When responding with code:

- Provide **complete, runnable** snippets for the target environment.
- Include the **minimum necessary** file set (component + CSS/module + any assets as inline SVG when possible).
- Name tokens clearly (`--bg`, `--ink`, `--accent`, `--radius`, `--shadow-*`, `--space-*`).
- Prefer **copy/paste-ready** results over vague guidance.

## Examples (quick prompts this skill should handle)

- “Make this dashboard page look premium and unforgettable.”
- “Design a landing page for a power analytics product—avoid generic SaaS vibes.”
- “Restyle my React component to an editorial magazine aesthetic.”
- “Create a poster-like hero section in HTML/CSS with dramatic typography and subtle grain.”

