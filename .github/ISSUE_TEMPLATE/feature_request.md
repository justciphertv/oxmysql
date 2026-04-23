---
name: Feature request
about: Propose a new feature for the justciphertv/oxmysql fork
title: ''
labels: enhancement
assignees: ''

---

> **This is a fork of [CommunityOx/oxmysql](https://github.com/CommunityOx/oxmysql).**
> Fork-specific features are kept in this repo; general-purpose enhancements that would benefit upstream are best proposed there first. Link an upstream discussion if one exists.

## Problem

What are you trying to accomplish that the current API does not support? Describe the user-facing pain point before the proposed solution.

## Proposed solution

Concrete description of the desired behaviour. Include:

- **Public API shape** — new method name, parameter list, return shape.
- **Default behaviour** — does this change anything for existing callers?
- **Convar / flag** — is it opt-in? What's the convar name? What's the default?

## Alternatives considered

What else have you looked at or tried? Why isn't that sufficient?

## Compatibility impact

- [ ] Fully additive; no existing caller sees a change.
- [ ] Behaviour change gated behind a new convar (default off).
- [ ] Behaviour change unconditional; would bump the minor version.
- [ ] Breaking change; would bump the major version.

## References

Link any related issues, upstream discussions, compat-matrix sections, or benchmarks that support the proposal.
