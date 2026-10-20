# Pantry Relay architecture explorer — redesign prompt

Design and implement a professional, interactive architecture explainer for a hackathon review. The audience includes judges, engineers, product stakeholders, and nonprofit operators. They need to understand the system in under two minutes, then inspect technical detail without being overwhelmed.

## Communication objective

Lead with one message: the agent interprets and explains, deterministic code decides eligibility, and the transactional workflow owns operational state. Present the current implementation honestly and make the target architecture easy to compare.

## Information architecture

1. Start with a compact orientation: what the product does, the central authority boundary, and four meaningful operating facts.
2. Make the architecture explorer the primary experience—not a long poster.
3. Provide three task-oriented views:
   - System map: a C4-inspired container overview with only the major components.
   - Request flow: a numbered donor-to-handoff sequence with actor, system, input, output, and guardrail.
   - Decision ownership: a clear responsibility matrix for the model, deterministic matcher, and workflow service.
4. Allow switching between Current and Target architecture without navigating away.
5. Support focus paths for Overview, Matching, Handoff, and Trust so only relevant nodes and connections are emphasized.
6. On node selection, show purpose, responsibilities, dependencies, status, and the hard boundary in a side inspector.
7. Offer true drill-down only where useful (agent runtime, matching, workflow, and data platform), with a breadcrumb and a back action.

## Interaction principles

- Use progressive disclosure: overview first, selection second, internals third.
- Do not show every connection at equal visual weight. Highlight the selected or focused path; mute the rest.
- Keep the selected object and its inspector visually connected.
- Use plain-language labels before implementation-specific names.
- Preserve keyboard access, visible focus, ARIA state, reduced-motion support, and mobile usability.
- On small screens, replace connector lines with a readable ordered stack; never force page-level horizontal scrolling.

## Visual direction

Use the restraint of a strong architecture review deck: warm neutral background, white working surfaces, deep green ink, one lime accent, thin borders, compact sans-serif typography, and generous but efficient spacing. Avoid decorative hero art, oversized display type, excessive shadows, dense card grids, and “spaghetti” diagrams. Status and ownership colors must carry meaning consistently.

## Acceptance criteria

- A new visitor can identify the agent, matcher, workflow authority, and primary stores without interaction.
- Current versus Target is obvious and changes the map content/statuses.
- Selecting a node updates the inspector and connected path.
- Drill-down and breadcrumb navigation work.
- Matching and Handoff focus modes reduce visual noise.
- Request-flow steps are individually inspectable and can be played automatically.
- Decision ownership distinguishes allowed actions from prohibited actions.
- Desktop and 375px mobile layouts have no page-level horizontal overflow.
- The implementation is dependency-free static HTML, CSS, and JavaScript inside `docs/architecture-site/dist`.
